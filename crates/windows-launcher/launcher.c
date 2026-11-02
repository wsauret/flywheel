/*
 * The Flywheel launchers on Windows: the console `flywheel.exe` on PATH and
 * the windowless `flywheel-service.exe` that Task Scheduler runs.
 *
 * Every installed build is one immutable directory in the account's versions
 * tree, as on macOS and Linux. Windows does not let a program replace or
 * delete a file that a running process executes, and it has no symbolic link
 * that a user can change atomically without extra privileges. So the one
 * stable file is this small program. It carries no Flywheel logic. It reads
 * the pointer file `<account home>\.flywheel\current`, whose text is the
 * active build directory relative to `<account home>\.flywheel`, and runs
 * `flywheel-bin.exe` from that directory. An update renames a new pointer
 * over the old one. It never touches this program or a build that runs.
 *
 * The account home is the one Flywheel uses: `HOME` when it is set and not
 * empty, else `USERPROFILE`, else the profile directory of the user.
 *
 * This program guarantees these things:
 *
 * 1. It opens the pointer with read, write, and delete sharing, and holds it
 *    for one read only. Windows refuses a replacing rename while any process
 *    has the file open, so the installer retries its rename, and a short hold
 *    keeps those refusals rare. This program retries a failed open or read
 *    for a short bounded time, because it can meet the pointer during a
 *    rename.
 * 2. It accepts only a relative path inside `<account home>\.flywheel`: no
 *    root, drive, UNC, or stream prefix, and no segment of only dots.
 * 3. The child gets this program's own command line tail byte for byte, the
 *    standard handles, the environment, and the working directory. The
 *    console launcher passes its console through; the service launcher
 *    creates neither a console nor a window. The exit code of this program is
 *    the exit code of the child.
 *    The environment also states `FLYWHEEL_INSTALL_DIR`, the directory this
 *    program is in, as the POSIX wrapper states its own directory: the build
 *    finds its launcher there, for the account service's registration and
 *    for every update. It never passes an inherited `FLYWHEEL_NATIVE_DIR`
 *    on: the POSIX wrapper sets that variable to the build's own native
 *    directory, and a build started with it unset finds the same directory
 *    beside its executable, so no caller can point a build at another
 *    build's native libraries.
 * 4. The child starts suspended and runs only after it is in a job object
 *    that kills it when this program ends, so the child never outlives a
 *    killed launcher. The job lets the processes that the child starts leave
 *    it silently, because Flywheel's guardian and command supervisors must
 *    outlive a service replacement.
 * 5. It ignores every console control event, so the child alone decides
 *    what Ctrl+C and Ctrl+Break do. A handler, not the inherited "ignore
 *    Ctrl+C" flag, does this, so the child keeps the default behavior. When
 *    the console closes, or the user logs off, or the system shuts down,
 *    this program waits for the child, so the job does not kill the child
 *    during its own cleanup.
 *
 * When this program fails before the child runs, it writes one sentence to
 * standard error and exits with one of these codes:
 *
 *   120  It cannot find the account home.
 *   121  It cannot open or read the pointer file.
 *   122  The pointer text is not a relative build path.
 *   123  It cannot put the child in a job object.
 *   124  It cannot wait for the child or read its exit code.
 *   125  It cannot allocate memory.
 *   126  It cannot start the build program.
 *   127  The build program does not exist.
 *   128  It cannot find its own directory.
 *
 * The compiled executables for x64 and arm64 are tracked in the repository
 * beside this source, and every build verifies them and this source against
 * launcher-prebuilt.json. A release never compiles this program. Rebuild it
 * only to change it on purpose, with `bun run build:windows-launcher`, and
 * commit the source, the executables, and the manifest together.
 */
#include <windows.h>
#include <userenv.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

enum {
  EXIT_NO_ACCOUNT_HOME = 120,
  EXIT_POINTER_UNREADABLE = 121,
  EXIT_POINTER_INVALID = 122,
  EXIT_NO_JOB = 123,
  EXIT_WAIT_FAILED = 124,
  EXIT_NO_MEMORY = 125,
  EXIT_CANNOT_START = 126,
  EXIT_TARGET_MISSING = 127,
  EXIT_NO_OWN_DIRECTORY = 128,
};

/* A pointer is a short relative path. A longer file is not a pointer. */
#define POINTER_MAX_BYTES 4096
/* How long a failed open or read of the pointer is retried. A rename that
 * replaces the pointer holds it for microseconds, so a failure that lasts
 * this long is not a rename. */
#define POINTER_RETRY_MS 500
#define POINTER_RETRY_STEP_MS 5
/* Task Scheduler must not create a terminal window at login or on demand. */
#ifdef FLYWHEEL_LAUNCHER_HIDDEN
#define CHILD_CREATION_FLAGS (CREATE_SUSPENDED | CREATE_NO_WINDOW)
#else
#define CHILD_CREATION_FLAGS CREATE_SUSPENDED
#endif

static HANDLE volatile child_process = NULL;

static void report(const wchar_t *sentence) {
  HANDLE error = GetStdHandle(STD_ERROR_HANDLE);
  if (error == NULL || error == INVALID_HANDLE_VALUE) return;
  DWORD mode = 0, written = 0;
  if (GetConsoleMode(error, &mode)) {
    WriteConsoleW(error, sentence, (DWORD)wcslen(sentence), &written, NULL);
    return;
  }
  int bytes = WideCharToMultiByte(CP_UTF8, 0, sentence, -1, NULL, 0, NULL, NULL);
  char *text = bytes > 0 ? HeapAlloc(GetProcessHeap(), 0, (size_t)bytes) : NULL;
  if (text == NULL) return;
  WideCharToMultiByte(CP_UTF8, 0, sentence, -1, text, bytes, NULL, NULL);
  WriteFile(error, text, (DWORD)bytes - 1, &written, NULL);
}

static void *allocate(size_t bytes) {
  void *memory = HeapAlloc(GetProcessHeap(), 0, bytes);
  if (memory == NULL) {
    report(L"Flywheel launcher: cannot allocate memory.\n");
    ExitProcess(EXIT_NO_MEMORY);
  }
  return memory;
}

static wchar_t *format(const wchar_t *pattern, ...) {
  va_list arguments;
  va_start(arguments, pattern);
  int length = _vscwprintf(pattern, arguments);
  va_end(arguments);
  wchar_t *text = allocate(((size_t)length + 1) * sizeof(wchar_t));
  va_start(arguments, pattern);
  _vsnwprintf(text, (size_t)length + 1, pattern, arguments);
  va_end(arguments);
  text[length] = L'\0';
  return text;
}

static int fail(int code, const wchar_t *sentence) {
  report(sentence);
  return code;
}

static BOOL WINAPI on_console_event(DWORD event) {
  if (event == CTRL_CLOSE_EVENT || event == CTRL_LOGOFF_EVENT || event == CTRL_SHUTDOWN_EVENT) {
    HANDLE child = child_process;
    if (child != NULL) WaitForSingleObject(child, INFINITE);
  }
  return TRUE;
}

static wchar_t *environment_value(const wchar_t *name) {
  DWORD size = GetEnvironmentVariableW(name, NULL, 0);
  if (size <= 1) return NULL;
  wchar_t *value = allocate(size * sizeof(wchar_t));
  DWORD length = GetEnvironmentVariableW(name, value, size);
  return length > 0 && length < size ? value : NULL;
}

static wchar_t *account_home(DWORD *error) {
  wchar_t *home = environment_value(L"HOME");
  if (home == NULL) home = environment_value(L"USERPROFILE");
  if (home != NULL) return home;
  HANDLE token = NULL;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
    *error = GetLastError();
    return NULL;
  }
  DWORD size = 0;
  GetUserProfileDirectoryW(token, NULL, &size);
  home = size > 0 ? allocate(size * sizeof(wchar_t)) : NULL;
  if (home == NULL || !GetUserProfileDirectoryW(token, home, &size)) {
    *error = GetLastError();
    home = NULL;
  }
  CloseHandle(token);
  return home;
}

/* Reads the whole pointer file, or returns NULL with the last Windows error
 * when every attempt in the retry window fails. */
static char *read_pointer(const wchar_t *path, DWORD *length, DWORD *error) {
  char *bytes = allocate(POINTER_MAX_BYTES);
  ULONGLONG deadline = GetTickCount64() + POINTER_RETRY_MS;
  for (;;) {
    HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file != INVALID_HANDLE_VALUE) {
      BOOL read = ReadFile(file, bytes, POINTER_MAX_BYTES, length, NULL);
      *error = read ? ERROR_SUCCESS : GetLastError();
      CloseHandle(file);
      if (read) return bytes;
    } else {
      *error = GetLastError();
    }
    if (GetTickCount64() >= deadline) return NULL;
    Sleep(POINTER_RETRY_STEP_MS);
  }
}

static BOOL is_separator(wchar_t character) {
  return character == L'\\' || character == L'/';
}

/* True when every segment has a character that is not a dot or a space.
 * Windows removes trailing dots and spaces from a segment, so a segment of
 * only dots and spaces can mean the parent directory. */
static BOOL is_relative_build_path(const wchar_t *path) {
  if (is_separator(path[0]) || wcschr(path, L':') != NULL) return FALSE;
  BOOL named = FALSE;
  for (const wchar_t *cursor = path;; cursor++) {
    if (*cursor == L'\0' || is_separator(*cursor)) {
      if (!named) return FALSE;
      if (*cursor == L'\0') return TRUE;
      named = FALSE;
    } else if (*cursor != L'.' && *cursor != L' ') {
      named = TRUE;
    }
  }
}

static BOOL is_trailing_space(char character) {
  return character == ' ' || character == '\t' || character == '\r' || character == '\n';
}

/* The build directory that the pointer names, or NULL when its text is not
 * UTF-8 or not a relative build path. */
static wchar_t *build_directory(const char *bytes, DWORD length) {
  if (length >= POINTER_MAX_BYTES) return NULL;
  while (length > 0 && is_trailing_space(bytes[length - 1])) length--;
  if (length == 0 || memchr(bytes, '\0', length) != NULL) return NULL;
  int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, bytes, (int)length, NULL, 0);
  if (count <= 0) return NULL;
  wchar_t *path = allocate(((size_t)count + 1) * sizeof(wchar_t));
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, bytes, (int)length, path, count);
  path[count] = L'\0';
  return is_relative_build_path(path) ? path : NULL;
}

/* The directory of this program's own file, or NULL with the Windows error. */
static wchar_t *own_directory(DWORD *error) {
  for (DWORD size = MAX_PATH;; size *= 2) {
    wchar_t *path = allocate((size_t)size * sizeof(wchar_t));
    DWORD length = GetModuleFileNameW(NULL, path, size);
    if (length == 0) {
      *error = GetLastError();
      return NULL;
    }
    if (length < size) {
      wchar_t *separator = wcsrchr(path, L'\\');
      if (separator == NULL) {
        *error = ERROR_BAD_PATHNAME;
        return NULL;
      }
      *separator = L'\0';
      return path;
    }
    if (size >= 32768) {
      *error = ERROR_INSUFFICIENT_BUFFER;
      return NULL;
    }
  }
}

/* This process's command line after its own program name, byte for byte. The
 * program name ends at its closing quote, or at the first space or tab when it
 * is not quoted, as CommandLineToArgvW reads it. */
static const wchar_t *command_line_tail(void) {
  const wchar_t *cursor = GetCommandLineW();
  if (*cursor == L'"') {
    cursor++;
    while (*cursor != L'\0' && *cursor != L'"') cursor++;
    if (*cursor == L'"') cursor++;
  } else {
    while (*cursor != L'\0' && *cursor != L' ' && *cursor != L'\t') cursor++;
  }
  while (*cursor == L' ' || *cursor == L'\t') cursor++;
  return cursor;
}

int wmain(void) {
  SetConsoleCtrlHandler(on_console_event, TRUE);

  DWORD error = ERROR_SUCCESS;
  wchar_t *home = account_home(&error);
  if (home == NULL) return fail(EXIT_NO_ACCOUNT_HOME, format(L"Flywheel launcher: cannot find the account home, because HOME and USERPROFILE are not set and the user profile directory is unknown (Windows error %lu).\n", error));

  wchar_t *pointer = format(L"%ls\\.flywheel\\current", home);
  DWORD length = 0;
  char *bytes = read_pointer(pointer, &length, &error);
  if (bytes == NULL) return fail(EXIT_POINTER_UNREADABLE, format(L"Flywheel launcher: cannot read the build pointer %ls (Windows error %lu).\n", pointer, error));
  wchar_t *build = build_directory(bytes, length);
  if (build == NULL) return fail(EXIT_POINTER_INVALID, format(L"Flywheel launcher: the build pointer %ls does not contain a relative path to a build directory in %ls\\.flywheel.\n", pointer, home));

  wchar_t *target = format(L"%ls\\.flywheel\\%ls\\flywheel-bin.exe", home, build);
  wchar_t *directory = own_directory(&error);
  if (directory == NULL || !SetEnvironmentVariableW(L"FLYWHEEL_INSTALL_DIR", directory)) {
    return fail(EXIT_NO_OWN_DIRECTORY, format(L"Flywheel launcher: cannot state its own directory to %ls (Windows error %lu).\n", target, directory == NULL ? error : GetLastError()));
  }
  /* A variable that is not set is already cleared, which is the one failure
   * this call can report. */
  SetEnvironmentVariableW(L"FLYWHEEL_NATIVE_DIR", NULL);
  const wchar_t *tail = command_line_tail();
  wchar_t *command = format(L"\"%ls\"%ls%ls", target, *tail != L'\0' ? L" " : L"", tail);

  HANDLE job = CreateJobObjectW(NULL, NULL);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  memset(&limits, 0, sizeof limits);
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
  if (job == NULL || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof limits)) {
    return fail(EXIT_NO_JOB, format(L"Flywheel launcher: cannot create the job object for %ls (Windows error %lu).\n", target, GetLastError()));
  }

  /* The child starts as this program started, which includes the show state
   * of its window and any standard handles that the parent named. Named
   * handles must be inheritable to reach the child. */
  STARTUPINFOW startup;
  GetStartupInfoW(&startup);
  if (startup.dwFlags & STARTF_USESTDHANDLES) {
    SetHandleInformation(startup.hStdInput, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
    SetHandleInformation(startup.hStdOutput, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
    SetHandleInformation(startup.hStdError, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
  }
  PROCESS_INFORMATION child;
  if (!CreateProcessW(target, command, NULL, NULL, TRUE, CHILD_CREATION_FLAGS, NULL, NULL, &startup, &child)) {
    error = GetLastError();
    if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) return fail(EXIT_TARGET_MISSING, format(L"Flywheel launcher: the build program %ls does not exist (Windows error %lu).\n", target, error));
    return fail(EXIT_CANNOT_START, format(L"Flywheel launcher: cannot start %ls (Windows error %lu).\n", target, error));
  }
  if (!AssignProcessToJobObject(job, child.hProcess)) {
    error = GetLastError();
    TerminateProcess(child.hProcess, EXIT_NO_JOB);
    return fail(EXIT_NO_JOB, format(L"Flywheel launcher: cannot put %ls in its job object (Windows error %lu).\n", target, error));
  }
  child_process = child.hProcess;
  if (ResumeThread(child.hThread) == (DWORD)-1) {
    error = GetLastError();
    TerminateProcess(child.hProcess, EXIT_CANNOT_START);
    return fail(EXIT_CANNOT_START, format(L"Flywheel launcher: cannot start %ls (Windows error %lu).\n", target, error));
  }
  CloseHandle(child.hThread);

  DWORD code = 0;
  if (WaitForSingleObject(child.hProcess, INFINITE) != WAIT_OBJECT_0 || !GetExitCodeProcess(child.hProcess, &code)) {
    return fail(EXIT_WAIT_FAILED, format(L"Flywheel launcher: cannot wait for %ls (Windows error %lu).\n", target, GetLastError()));
  }
  return (int)code;
}

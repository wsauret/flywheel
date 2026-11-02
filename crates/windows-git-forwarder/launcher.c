/*
 * PATH-first git.exe for one mutating command. This is not the account launcher.
 *
 * Descriptor contract (UTF-16 Windows environment):
 * FLYWHEEL_MUTATION_GIT_RUNTIME: absolute path of the pinned runtime executable.
 * FLYWHEEL_MUTATION_GIT_SOURCE: optional absolute source entry for a Bun source run.
 * Unset or empty SOURCE selects a packaged executable. The producer supplies
 * these per execution, before placing this asset in the wrapper directory.
 *
 * The child command is:
 *   runtime [--conditions=browser source] --internal-role=mutation-git -- <original tail>
 * The policy role owns all Git configuration and real-Git descriptors.
 * No argument is evaluated by a shell. The original command tail is copied
 * unchanged; only the descriptor paths receive Windows argv quoting.
 *
 * The existing owned-command job contains this process and its descendants.
 * This forwarder creates no job and requests no breakaway or survival flags.
 * The child inherits cwd, environment, console, and standard handles.
 * Its full DWORD exit code is returned unchanged.
 *
 * Setup failures write a fixed sentence to stderr, without descriptor values:
 * 120 missing/invalid descriptor, 124 wait failure, 125 allocation failure,
 * 126 process creation failure.
 */
#include <windows.h>
#include <wchar.h>
#include <string.h>

_Noreturn static void fail(UINT code, const char *message) {
  DWORD written;
  WriteFile(GetStdHandle(STD_ERROR_HANDLE), message, (DWORD)strlen(message), &written, NULL);
  ExitProcess(code);
}

static wchar_t *allocate(size_t count) {
  wchar_t *memory = HeapAlloc(GetProcessHeap(), 0, count * sizeof(wchar_t));
  if (memory == NULL) fail(125, "Flywheel Git forwarder: cannot allocate memory.\n");
  return memory;
}

static wchar_t *environment(const wchar_t *name) {
  DWORD size = GetEnvironmentVariableW(name, NULL, 0);
  if (size == 0) return NULL;
  wchar_t *value = allocate(size);
  DWORD length = GetEnvironmentVariableW(name, value, size);
  if (length == 0 || length >= size) fail(120, "Flywheel Git forwarder: cannot read the execution descriptor.\n");
  return value;
}

static BOOL absolute_path(const wchar_t *path) {
  return path != NULL && (
    ((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z'))
      ? path[1] == L':' && (path[2] == L'\\' || path[2] == L'/')
      : path[0] == L'\\' && path[1] == L'\\');
}

/* Windows argv parsing doubles backslashes before quotes and the closing quote. */
static wchar_t *quote(const wchar_t *value) {
  wchar_t *quoted = allocate(wcslen(value) * 2 + 3);
  wchar_t *out = quoted;
  *out++ = L'"';
  for (const wchar_t *cursor = value; *cursor != L'\0';) {
    size_t slashes = 0;
    while (*cursor == L'\\') { slashes++; cursor++; }
    size_t copies = (*cursor == L'"' || *cursor == L'\0') ? slashes * 2 : slashes;
    while (copies-- > 0) *out++ = L'\\';
    if (*cursor == L'\0') break;
    if (*cursor == L'"') *out++ = L'\\';
    *out++ = *cursor++;
  }
  *out++ = L'"';
  *out = L'\0';
  return quoted;
}

/* argv[0] has special Windows parsing: quotes delimit a path, not escapes. */
static const wchar_t *command_line_tail(void) {
  const wchar_t *cursor = GetCommandLineW();
  BOOL quoted = FALSE;
  while (*cursor != L'\0') {
    if (*cursor == L'"') quoted = !quoted;
    else if (!quoted && (*cursor == L' ' || *cursor == L'\t')) break;
    cursor++;
  }
  return cursor;
}

/* The runtime, not this waiting forwarder, handles console interrupts. */
static BOOL WINAPI on_console_event(DWORD event) {
  (void)event;
  return TRUE;
}

int wmain(void) {
  wchar_t *runtime = environment(L"FLYWHEEL_MUTATION_GIT_RUNTIME");
  wchar_t *source = environment(L"FLYWHEEL_MUTATION_GIT_SOURCE");
  if (!absolute_path(runtime) || (source != NULL && !absolute_path(source)))
    fail(120, "Flywheel Git forwarder: a pinned absolute runtime/source descriptor is required.\n");

  const wchar_t *runtime_arg = quote(runtime);
  const wchar_t *source_arg = source == NULL ? L"" : quote(source);
  const wchar_t *source_flag = source == NULL ? L"" : L" --conditions=browser ";
  const wchar_t *role = L" --internal-role=mutation-git --";
  const wchar_t *tail = command_line_tail();
  size_t size = wcslen(runtime_arg) + wcslen(source_flag) + wcslen(source_arg) + wcslen(role) + wcslen(tail) + 1;
  wchar_t *command = allocate(size);
  wcscpy(command, runtime_arg);
  wcscat(command, source_flag);
  wcscat(command, source_arg);
  wcscat(command, role);
  wcscat(command, tail);

  STARTUPINFOW startup = {0};
  startup.cb = sizeof startup;
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  HANDLE handles[] = {startup.hStdInput, startup.hStdOutput, startup.hStdError};
  for (size_t i = 0; i < sizeof handles / sizeof handles[0]; i++) {
    if (handles[i] != NULL && handles[i] != INVALID_HANDLE_VALUE)
      SetHandleInformation(handles[i], HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
  }
  SetConsoleCtrlHandler(on_console_event, TRUE);
  PROCESS_INFORMATION child;
  if (!CreateProcessW(runtime, command, NULL, NULL, TRUE, 0, NULL, NULL, &startup, &child))
    fail(126, "Flywheel Git forwarder: cannot start the pinned runtime.\n");
  CloseHandle(child.hThread);
  DWORD code;
  if (WaitForSingleObject(child.hProcess, INFINITE) != WAIT_OBJECT_0 || !GetExitCodeProcess(child.hProcess, &code))
    fail(124, "Flywheel Git forwarder: cannot wait for the pinned runtime.\n");
  CloseHandle(child.hProcess);
  ExitProcess(code);
}

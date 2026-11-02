/*
 * The launchd program for the Flywheel account service on macOS.
 *
 * macOS privacy consent (TCC) attributes a launchd job's access to protected
 * folders to the job's own process, keyed by that executable's path and code
 * identity, and every child inherits the attribution. The service itself is a
 * new executable at a new path on every release, so a job that ran it directly
 * asked the user for the Documents folder again after each update. This
 * program is what launchd runs instead: it spawns the installed `flywheel
 * serve` as a child in this program's own process group, the group that
 * launchd gives the job, and waits. The consent attaches
 * to this program once, and the child changes underneath it freely. It ships
 * inside a minimal application bundle so the consent dialog and the Privacy &
 * Security entry name and picture it as Flywheel rather than as a bare
 * executable.
 *
 * The compiled bytes are therefore part of the product's identity. They are
 * built once with `bun run build:macos-launcher`, ad-hoc signed with one fixed
 * identifier, tracked in the repository beside this source, and verified
 * against launcher-prebuilt.json by every build. Rebuilding changes the code
 * identity and asks every macOS user for consent one more time, so it is a
 * deliberate act, never part of a release build.
 *
 * Signals launchd sends to end the job are forwarded to the child, and the
 * exit status is the child's, so launchd's KeepAlive sees the service's own
 * lifecycle. launchd kills the remaining process group when this process
 * exits, which is how a child outliving a killed launcher is prevented. That
 * kill reaches the service. It reaches neither the service's guardian nor its
 * command supervisors, because each of them leads its own process group.
 */
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static volatile pid_t child = 0;

static void forward(int signal_number) {
  pid_t target = child;
  if (target > 0) kill(target, signal_number);
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fputs("usage: Flywheel <command> [argument ...]\n", stderr);
    return 64;
  }
  struct sigaction action;
  memset(&action, 0, sizeof action);
  action.sa_handler = forward;
  action.sa_flags = SA_RESTART;
  sigaction(SIGTERM, &action, NULL);
  sigaction(SIGINT, &action, NULL);
  sigaction(SIGHUP, &action, NULL);

  pid_t spawned = 0;
  int error = posix_spawn(&spawned, argv[1], NULL, NULL, argv + 1, environ);
  if (error != 0) {
    fprintf(stderr, "Flywheel launcher: cannot start %s: %s\n", argv[1], strerror(error));
    return 126;
  }
  child = spawned;

  int status = 0;
  while (waitpid(spawned, &status, 0) < 0) {
    if (errno != EINTR) {
      fprintf(stderr, "Flywheel launcher: cannot wait for %s: %s\n", argv[1], strerror(errno));
      return 70;
    }
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 70;
}

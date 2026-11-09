#define _GNU_SOURCE
#include <jni.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

static long millis(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000L + ts.tv_nsec / 1000000L;
}

static int run_shell(int forced, char *output, size_t capacity, int *status_out) {
    int master = posix_openpt(O_RDWR | O_NOCTTY | O_CLOEXEC);
    if (master < 0) return -errno;
    if (grantpt(master) || unlockpt(master)) { int e = errno; close(master); return -e; }
    char slave_name[128];
    if (ptsname_r(master, slave_name, sizeof(slave_name))) {
        int e = errno; close(master); return -e;
    }
    pid_t child = fork();
    if (child < 0) { int e = errno; close(master); return -e; }
    if (child == 0) {
        setsid();
        int slave = open(slave_name, O_RDWR);
        if (slave < 0) _exit(125);
        ioctl(slave, TIOCSCTTY, 0);
        dup2(slave, STDIN_FILENO);
        dup2(slave, STDOUT_FILENO);
        dup2(slave, STDERR_FILENO);
        if (slave > STDERR_FILENO) close(slave);
        close(master);
        char *argv[] = { "sh", NULL };
        execv("/system/bin/sh", argv);
        _exit(127);
    }

    struct termios tty;
    if (tcgetattr(master, &tty) == 0) {
        tty.c_lflag &= (tcflag_t)~ECHO;
        tcsetattr(master, TCSANOW, &tty);
    }
    const char *input = forced ? "sleep 30\n" : "printf 'PTY_INPUT_OK\\n'\nexit\n";
    (void)write(master, input, strlen(input));
    if (forced) {
        struct timespec pause_time = { 0, 200000000 };
        nanosleep(&pause_time, NULL);
        // The child calls setsid(), making its PID the shell's process-group ID.
        kill(-child, SIGTERM);
        kill(child, SIGTERM);
    }

    size_t used = 0;
    long deadline = millis() + 5000;
    int status = 0;
    int reaped = 0;
    while (millis() < deadline) {
        struct pollfd pfd = { .fd = master, .events = POLLIN };
        int polled = poll(&pfd, 1, 100);
        if (polled > 0 && (pfd.revents & POLLIN) && used + 1 < capacity) {
            ssize_t count = read(master, output + used, capacity - used - 1);
            if (count > 0) used += (size_t)count;
        }
        if (waitpid(child, &status, WNOHANG) == child) { reaped = 1; break; }
    }
    if (!reaped) {
        kill(-child, SIGKILL);
        kill(child, SIGKILL);
        waitpid(child, &status, 0);
    }
    close(master);
    output[used] = 0;
    *status_out = status;
    return reaped ? 0 : -ETIMEDOUT;
}

JNIEXPORT jstring JNICALL
Java_com_nthnentps_linuxprobe_ProbeActivity_runPtyTests(JNIEnv *env, jclass ignored) {
    (void)ignored;
    char normal[2048] = {0}, forced[512] = {0}, report[4096];
    int normal_status = 0, forced_status = 0;
    int normal_rc = run_shell(0, normal, sizeof(normal), &normal_status);
    int forced_rc = run_shell(1, forced, sizeof(forced), &forced_status);
    int input_ok = normal_rc == 0 && strstr(normal, "PTY_INPUT_OK") != NULL;
    int normal_exit = normal_rc == 0 && WIFEXITED(normal_status) && WEXITSTATUS(normal_status) == 0;
    int terminated = forced_rc == 0 && WIFSIGNALED(forced_status)
                     && WTERMSIG(forced_status) == SIGTERM;
    snprintf(report, sizeof(report),
             "PTY input/output=%s; shell exit=%s; forced SIGTERM=%s\n"
             "normal rc=%d status=%d; forced rc=%d status=%d\nnormal transcript: %.1800s",
             input_ok ? "PASS" : "FAIL", normal_exit ? "PASS" : "FAIL",
             terminated ? "PASS" : "FAIL", normal_rc, normal_status,
             forced_rc, forced_status, normal);
    return (*env)->NewStringUTF(env, report);
}

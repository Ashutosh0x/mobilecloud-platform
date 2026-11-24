// MobileCloud JNI bridge (master blueprint; APK build spec section 2).
//
// Library: libmobilecloud_native.so (loaded by NativePtyController).
// Local PTY support: forkpty + non-blocking master fd.
//
// When tmux is bundled the child is `tmux new-session -A -s <session>`, so a
// closed tab / destroyed activity re-attaches to a live shell instead of
// killing long-running work. Without tmux the child is a plain login shell.
//
// StrongBox KeyStore operations stay on the Kotlin side: the TEE keymaster
// is a Binder service, not reachable from native code.

#include <jni.h>
#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <mutex>
#include <unordered_map>
#include <unistd.h>
#include <termios.h>
#include <pty.h>
#include <sys/wait.h>
#include <sys/ioctl.h>
#include <android/log.h>

#define TAG "MobileCloudJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

namespace {

// Non-blocking master so JNI reads return EAGAIN instead of blocking the
// caller's event loop.
int set_nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags < 0) return -1;
    return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

// master fd -> child pid.
//
// `waitpid(-1, …)` would reap *any* child of the app process, which steals
// the exit status of an unrelated process (the tmux client, a build that was
// spawned from a previous session). The child of a PTY is known exactly, so
// it is tracked here and only that pid is waited for.
std::mutex g_children_mutex;
std::unordered_map<int, pid_t> g_children;

void remember_child(int master_fd, pid_t child) {
    std::lock_guard<std::mutex> guard(g_children_mutex);
    g_children[master_fd] = child;
}

pid_t forget_child(int master_fd) {
    std::lock_guard<std::mutex> guard(g_children_mutex);
    auto it = g_children.find(master_fd);
    if (it == g_children.end()) return -1;
    pid_t child = it->second;
    g_children.erase(it);
    return child;
}

// Environment shared by the login shell and the tmux client. Truecolor and a
// UTF-8 locale are what make `btop`, `bat`, and powerline prompts render
// correctly over the phone's terminal.
void apply_child_environment(const char *home, const char *path, const char *shell) {
    setenv("TERM", "xterm-256color", 1);
    setenv("COLORTERM", "truecolor", 1);
    setenv("TERM_PROGRAM", "mobilecloud", 1);
    setenv("TERM_PROGRAM_VERSION", "2.0", 1);
    setenv("LANG", "C.UTF-8", 1);
    setenv("LC_ALL", "C.UTF-8", 1);
    setenv("HOME", home, 1);
    setenv("PATH", path, 1);
    setenv("SHELL", shell, 1);
    if (getenv("PS1") == nullptr) setenv("PS1", "mobilecloud$ ", 1);
    unsetenv("ANDROID_DATA");
    unsetenv("ANDROID_ROOT");
    // tmux refuses to attach when TERM is unknown to its terminfo database.
    // The engine ships tmux + terminfo; the fallback keeps a bare shell usable.
}

} // namespace

extern "C" {

// ---------------------------------------------------------------------------
// PTY subsystem (com.mobilecloud.terminal.NativePtyController)
// ---------------------------------------------------------------------------

extern "C" JNIEXPORT jint JNICALL
Java_com_mobilecloud_terminal_NativePtyController_nativeSpawnPty(
        JNIEnv *env, jclass, jint rows, jint cols,
        jstring shellPath, jstring envHome, jstring envPath,
        jstring tmuxPath, jstring tmuxConf) {
    const char *shell = env->GetStringUTFChars(shellPath, nullptr);
    const char *home = env->GetStringUTFChars(envHome, nullptr);
    const char *path = env->GetStringUTFChars(envPath, nullptr);
    const char *tmux = tmuxPath == nullptr ? nullptr : env->GetStringUTFChars(tmuxPath, nullptr);
    const char *conf = tmuxConf == nullptr ? nullptr : env->GetStringUTFChars(tmuxConf, nullptr);

    struct winsize ws{};
    ws.ws_row = static_cast<unsigned short>(rows);
    ws.ws_col = static_cast<unsigned short>(cols);

    int master_fd = -1;
    pid_t child = forkpty(&master_fd, nullptr, nullptr, &ws);
    if (child < 0) {
        LOGE("forkpty failed: %s", strerror(errno));
        int error = errno;
        env->ReleaseStringUTFChars(shellPath, shell);
        env->ReleaseStringUTFChars(envHome, home);
        env->ReleaseStringUTFChars(envPath, path);
        if (tmux != nullptr) env->ReleaseStringUTFChars(tmuxPath, tmux);
        if (conf != nullptr) env->ReleaseStringUTFChars(tmuxConf, conf);
        return -error;
    }

    if (child == 0) {
        // These preferences do not isolate the child from the app UID or
        // its resources. The local PTY is not a security boundary.
        apply_child_environment(home, path, shell);
        if (tmux != nullptr && tmux[0] != '\0') {
            if (conf != nullptr && conf[0] != '\0') {
                execl(tmux, tmux, "-u", "-f", conf,
                      "new-session", "-A", "-s", "mobilecloud-session", (char *) nullptr);
            } else {
                execl(tmux, tmux, "-u",
                      "new-session", "-A", "-s", "mobilecloud-session", (char *) nullptr);
            }
        }
        // tmux missing or exec failed: hand out a direct login shell.
        execl(shell, shell, "-l", (char *) nullptr);
        _exit(127); // exec failed
    }

    set_nonblocking(master_fd);
    remember_child(master_fd, child);
    LOGI("PTY spawned: master=%d child=%d shell=%s tmux=%s",
         master_fd, child, shell, (tmux != nullptr && tmux[0] != '\0') ? tmux : "none");

    env->ReleaseStringUTFChars(shellPath, shell);
    env->ReleaseStringUTFChars(envHome, home);
    env->ReleaseStringUTFChars(envPath, path);
    if (tmux != nullptr) env->ReleaseStringUTFChars(tmuxPath, tmux);
    if (conf != nullptr) env->ReleaseStringUTFChars(tmuxConf, conf);
    return master_fd;
}

extern "C" JNIEXPORT jint JNICALL
Java_com_mobilecloud_terminal_NativePtyController_nativeReadPty(
        JNIEnv *env, jclass, jint fd, jbyteArray buffer, jint maxBytes) {
    if (buffer == nullptr || maxBytes < 0 || maxBytes > env->GetArrayLength(buffer)) return -EINVAL;
    if (maxBytes == 0) return 0;
    jbyte buf[4096];
    int to_read = maxBytes < 4096 ? maxBytes : 4096;
    ssize_t n = read(fd, buf, to_read);
    if (n < 0) {
        return (errno == EAGAIN || errno == EWOULDBLOCK) ? 0 : -errno;
    }
    if (n == 0) return -EIO; // EOF - slave closed
    env->SetByteArrayRegion(buffer, 0, n, buf);
    return env->ExceptionCheck() ? -EIO : static_cast<jint>(n);
}

extern "C" JNIEXPORT jint JNICALL
Java_com_mobilecloud_terminal_NativePtyController_nativeWritePty(
        JNIEnv *env, jclass, jint fd, jbyteArray buffer, jint length) {
    if (buffer == nullptr || length < 0 || length > env->GetArrayLength(buffer)) return -EINVAL;
    if (length == 0) return 0;
    jbyte buf[4096];
    int to_write = length < 4096 ? length : 4096;
    env->GetByteArrayRegion(buffer, 0, to_write, buf);
    if (env->ExceptionCheck()) return -EIO;
    ssize_t n = write(fd, buf, to_write);
    return n < 0 ? -errno : static_cast<jint>(n);
}

extern "C" JNIEXPORT jint JNICALL
Java_com_mobilecloud_terminal_NativePtyController_nativeResizePty(
        JNIEnv *, jclass, jint fd, jint rows, jint cols) {
    struct winsize ws{};
    ws.ws_row = static_cast<unsigned short>(rows);
    ws.ws_col = static_cast<unsigned short>(cols);
    return ioctl(fd, TIOCSWINSZ, &ws) == 0 ? 0 : -errno;
}

extern "C" JNIEXPORT void JNICALL
Java_com_mobilecloud_terminal_NativePtyController_nativeClosePty(
        JNIEnv *, jclass, jint fd) {
    close(fd);
    // Reap exactly the child this PTY spawned. `waitpid(-1, …)` would also
    // reap unrelated children of the app process and steal their exit status.
    pid_t child = forget_child(fd);
    if (child <= 0) return;
    int status = 0;
    if (waitpid(child, &status, WNOHANG) == 0) {
        // The shell has not noticed the hangup yet. Ask it to exit, then give
        // it one more chance without blocking the caller indefinitely.
        kill(child, SIGHUP);
        usleep(50 * 1000);
        waitpid(child, &status, WNOHANG);
    }
}

} // extern "C"

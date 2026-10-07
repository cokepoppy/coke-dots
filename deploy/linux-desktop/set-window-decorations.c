#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <X11/Xatom.h>
#include <X11/Xlib.h>

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: %s WINDOW_ID\n", argv[0]);
    return 2;
  }

  errno = 0;
  char *end = NULL;
  unsigned long window_id = strtoul(argv[1], &end, 0);
  if (errno != 0 || end == argv[1] || *end != '\0') {
    fprintf(stderr, "invalid X11 window ID: %s\n", argv[1]);
    return 2;
  }

  Display *display = XOpenDisplay(NULL);
  if (display == NULL) {
    fprintf(stderr, "cannot connect to X display\n");
    return 1;
  }

  Atom hints_atom = XInternAtom(display, "_MOTIF_WM_HINTS", False);
  unsigned long hints[5] = {2, 0, 0, 0, 0};
  XChangeProperty(display, (Window)window_id, hints_atom, hints_atom, 32,
                  PropModeReplace, (unsigned char *)hints, 5);
  XSync(display, False);
  XCloseDisplay(display);
  return 0;
}

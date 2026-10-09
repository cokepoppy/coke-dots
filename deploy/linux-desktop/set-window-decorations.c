#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <X11/Xatom.h>
#include <X11/Xlib.h>

static Window find_client_window(Display *display, Window window, Atom wm_state) {
  Atom actual_type = None;
  int actual_format = 0;
  unsigned long item_count = 0;
  unsigned long bytes_after = 0;
  unsigned char *property = NULL;
  if (XGetWindowProperty(display, window, wm_state, 0, 0, False, AnyPropertyType,
                         &actual_type, &actual_format, &item_count, &bytes_after,
                         &property) == Success && actual_type != None) {
    if (property != NULL) XFree(property);
    return window;
  }
  if (property != NULL) XFree(property);

  Window root = None;
  Window parent = None;
  Window *children = NULL;
  unsigned int child_count = 0;
  if (!XQueryTree(display, window, &root, &parent, &children, &child_count)) return None;
  Window client = None;
  for (unsigned int index = 0; index < child_count && client == None; index++) {
    client = find_client_window(display, children[index], wm_state);
  }
  if (children != NULL) XFree(children);
  return client;
}

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
  Atom wm_state_atom = XInternAtom(display, "WM_STATE", False);
  Window client_window = find_client_window(display, (Window)window_id, wm_state_atom);
  if (client_window == None) client_window = (Window)window_id;
  unsigned long hints[5] = {2, 0, 0, 0, 0};
  XChangeProperty(display, client_window, hints_atom, hints_atom, 32,
                  PropModeReplace, (unsigned char *)hints, 5);
  XSync(display, False);
  fprintf(stderr, "Applied Motif decoration hints to Chromium client 0x%lx (requested 0x%lx)\n",
          client_window, (Window)window_id);
  XCloseDisplay(display);
  return 0;
}

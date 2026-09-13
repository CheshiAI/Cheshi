#ifndef CHESHI_GHOSTTY_BRIDGE_H_
#define CHESHI_GHOSTTY_BRIDGE_H_

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef void (*cheshi_ghostty_event_callback)(
    int32_t surface_id,
    const char *type,
    const char *value);

void cheshi_ghostty_set_event_callback(cheshi_ghostty_event_callback callback);
bool cheshi_ghostty_initialize(const char *font_directory);
int32_t cheshi_ghostty_surface_create(
    void *root_view,
    double x,
    double y,
    double width,
    double height,
    const char *working_directory,
    bool dark);
bool cheshi_ghostty_surface_resize(
    int32_t surface_id,
    double x,
    double y,
    double width,
    double height);
bool cheshi_ghostty_surface_destroy(int32_t surface_id);
bool cheshi_ghostty_surface_set_focus(int32_t surface_id, bool focused);
bool cheshi_ghostty_surface_set_occluded(int32_t surface_id, bool occluded);
void cheshi_ghostty_set_dark(bool dark);

#ifdef __cplusplus
}
#endif

#endif

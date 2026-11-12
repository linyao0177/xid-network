idf_component_register(
  SRCS "boat_depin.c"
  INCLUDE_DIRS "include"
  REQUIRES boat_device esp_wifi json freertos espressif__libsodium
)

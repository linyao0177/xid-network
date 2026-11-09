idf_component_register(
  SRCS "boat_device.c" "seal.c"
  INCLUDE_DIRS "include"
  REQUIRES hdht hdht_mqtt mqtt nvs_flash esp_netif esp_timer espressif__libsodium
)

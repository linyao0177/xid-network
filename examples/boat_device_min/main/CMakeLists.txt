idf_component_register(
  SRCS "main.c"
  REQUIRES boat_device boat_wifi nvs_flash esp_netif esp_event esp_timer
)

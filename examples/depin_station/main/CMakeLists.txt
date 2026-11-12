idf_component_register(
  SRCS "main.c"
  REQUIRES boat_device boat_depin boat_wifi nvs_flash esp_netif esp_event esp_timer esp_wifi esp_driver_tsens
)

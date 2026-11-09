idf_component_register(
  SRCS "main.c"
  REQUIRES boat_device nvs_flash esp_netif esp_event esp_timer protocol_examples_common
)

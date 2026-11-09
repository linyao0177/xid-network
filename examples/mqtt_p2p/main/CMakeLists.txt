idf_component_register(
  SRCS "main.c"
  REQUIRES hdht hdht_mqtt mqtt esp_driver_gpio nvs_flash esp_netif esp_event esp_timer protocol_examples_common
)

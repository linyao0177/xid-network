idf_component_register(
  SRCS "main.c"
  REQUIRES hdht hdht_mqtt mqtt nvs_flash esp_netif esp_event esp_timer protocol_examples_common
)

# boat_wifi: a Wi-Fi station whose network is set over the serial console
# with Improv Wi-Fi (https://www.improv-wifi.com/serial/), as browser
# installers such as ESP Web Tools do right after flashing.
idf_component_register(
  SRCS boat_wifi.c
  INCLUDE_DIRS include
  REQUIRES esp_wifi esp_netif esp_event nvs_flash
  PRIV_REQUIRES esp_app_format esp_driver_usb_serial_jtag esp_driver_uart vfs
)

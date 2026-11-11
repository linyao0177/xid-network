// A Wi-Fi station whose network is kept in NVS and set over the serial
// console with Improv Wi-Fi (https://www.improv-wifi.com/serial/).
//
// Improv packets: "IMPROV" | version 1 | type | length | data | checksum (the
// sum of all bytes before it), sent here followed by a newline. They go
// straight through the console's driver (stdout would turn a 0x0A byte into
// CR LF), with stdout locked so a packet never lands inside a log line.

#include <string.h>

#include "boat_wifi.h"

#include "esp_app_desc.h"
#include "esp_check.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "freertos/timers.h"
#include "nvs.h"
#include "sdkconfig.h"

#if CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG
#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#define IMPROV_PORT 1
#elif CONFIG_ESP_CONSOLE_UART
#include "driver/uart.h"
#include "driver/uart_vfs.h"
#define IMPROV_PORT 1
#else
#define IMPROV_PORT 0
#endif

static const char *TAG = "boat_wifi";

#if CONFIG_IDF_TARGET_ESP32C3
#define CHIP_FAMILY "ESP32-C3"
#elif CONFIG_IDF_TARGET_ESP32C6
#define CHIP_FAMILY "ESP32-C6"
#elif CONFIG_IDF_TARGET_ESP32S3
#define CHIP_FAMILY "ESP32-S3"
#elif CONFIG_IDF_TARGET_ESP32
#define CHIP_FAMILY "ESP32"
#else
#define CHIP_FAMILY CONFIG_IDF_TARGET
#endif

#define CONNECTED BIT0
#define PROVISION_WAIT_MS 20000

enum { STATE_READY = 0x02, STATE_PROVISIONING = 0x03, STATE_PROVISIONED = 0x04 };
enum { ERR_NONE = 0x00, ERR_BAD_PACKET = 0x01, ERR_UNKNOWN_RPC = 0x02, ERR_NO_CONNECT = 0x03 };
enum { TYPE_STATE = 0x01, TYPE_ERROR = 0x02, TYPE_RPC = 0x03, TYPE_RESULT = 0x04 };
enum { RPC_WIFI = 0x01, RPC_STATE = 0x02, RPC_INFO = 0x03, RPC_SCAN = 0x04 };

static boat_wifi_config_t config;
static EventGroupHandle_t events;
static TimerHandle_t retry;
static char ssid[33];
static char password[65];
static volatile bool scanning;

static const char *
ns (void) {
  return config.nvs_namespace ? config.nvs_namespace : "boat_wifi";
}

static void
apply (const char *s, const char *p) {
  wifi_config_t wc = {0};
  memcpy(wc.sta.ssid, s, strnlen(s, 32));
  memcpy(wc.sta.password, p, strnlen(p, 64));
  esp_wifi_set_config(WIFI_IF_STA, &wc);
}

static void
connect_now (TimerHandle_t t) {
  (void) t;
  if (ssid[0] && !scanning) esp_wifi_connect();
}

static void
on_event (void *arg, esp_event_base_t base, int32_t id, void *data) {
  (void) arg;
  (void) data;
  if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
    connect_now(NULL);
  } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
    xEventGroupClearBits(events, CONNECTED);
    xTimerStart(retry, 0); // again in a second, however long the network is gone
  } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
    ip_event_got_ip_t *e = data;
    ESP_LOGI(TAG, "connected to %s, address " IPSTR, ssid, IP2STR(&e->ip_info.ip));
    xEventGroupSetBits(events, CONNECTED);
  }
}

static void
load (void) {
  nvs_handle_t nvs;
  size_t len;
  ssid[0] = password[0] = '\0';
  if (nvs_open(ns(), NVS_READONLY, &nvs) == ESP_OK) {
    len = sizeof(ssid);
    if (nvs_get_str(nvs, "ssid", ssid, &len) != ESP_OK) ssid[0] = '\0';
    len = sizeof(password);
    if (nvs_get_str(nvs, "pass", password, &len) != ESP_OK) password[0] = '\0';
    nvs_close(nvs);
  }
  if (!ssid[0] && config.ssid && config.ssid[0]) {
    strlcpy(ssid, config.ssid, sizeof(ssid));
    strlcpy(password, config.password ? config.password : "", sizeof(password));
  }
}

static esp_err_t
save (const char *s, const char *p) {
  nvs_handle_t nvs;
  esp_err_t err = nvs_open(ns(), NVS_READWRITE, &nvs);
  if (err != ESP_OK) return err;
  if (s[0]) {
    err = nvs_set_str(nvs, "ssid", s);
    if (err == ESP_OK) err = nvs_set_str(nvs, "pass", p);
  } else {
    nvs_erase_key(nvs, "ssid");
    nvs_erase_key(nvs, "pass");
  }
  if (err == ESP_OK) err = nvs_commit(nvs);
  nvs_close(nvs);
  return err;
}

bool
boat_wifi_connected (void) {
  return events && (xEventGroupGetBits(events) & CONNECTED);
}

bool
boat_wifi_wait (TickType_t timeout) {
  return events && (xEventGroupWaitBits(events, CONNECTED, pdFALSE, pdTRUE, timeout) & CONNECTED);
}

// tries a network; keeps it only if it gets an address within wait_ms, else
// goes back to the one before
static bool
try_network (const char *s, const char *p, uint32_t wait_ms) {
  char old_ssid[33], old_pass[65];
  strlcpy(old_ssid, ssid, sizeof(old_ssid));
  strlcpy(old_pass, password, sizeof(old_pass));
  strlcpy(ssid, s, sizeof(ssid));
  strlcpy(password, p, sizeof(password));
  xEventGroupClearBits(events, CONNECTED);
  esp_wifi_disconnect();
  apply(ssid, password);
  if (ssid[0]) esp_wifi_connect();
  bool ok = !s[0] || boat_wifi_wait(pdMS_TO_TICKS(wait_ms));
  if (ok) {
    save(s, p);
  } else {
    ESP_LOGW(TAG, "could not join %s; back to the network before", s);
    strlcpy(ssid, old_ssid, sizeof(ssid));
    strlcpy(password, old_pass, sizeof(password));
    esp_wifi_disconnect();
    apply(ssid, password);
    if (ssid[0]) esp_wifi_connect();
  }
  memset(old_pass, 0, sizeof(old_pass));
  return ok;
}

esp_err_t
boat_wifi_set (const char *s, const char *p) {
  if (!events || strlen(s) > 32 || strlen(p) > 64) return ESP_ERR_INVALID_ARG;
  esp_err_t err = save(s, p);
  if (err != ESP_OK) return err;
  strlcpy(ssid, s, sizeof(ssid));
  strlcpy(password, p, sizeof(password));
  xEventGroupClearBits(events, CONNECTED);
  esp_wifi_disconnect();
  apply(ssid, password);
  if (ssid[0]) esp_wifi_connect();
  return ESP_OK;
}

// Improv

#if IMPROV_PORT

static int
port_read (uint8_t *buf, size_t len) {
#if CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG
  return usb_serial_jtag_read_bytes(buf, len, portMAX_DELAY);
#else
  return uart_read_bytes(CONFIG_ESP_CONSOLE_UART_NUM, buf, len, portMAX_DELAY);
#endif
}

static void
port_write (const uint8_t *data, size_t len) {
  flockfile(stdout);
  fflush(stdout);
#if CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG
  usb_serial_jtag_write_bytes(data, len, pdMS_TO_TICKS(200));
#else
  uart_write_bytes(CONFIG_ESP_CONSOLE_UART_NUM, data, len);
#endif
  funlockfile(stdout);
}

static void
send_packet (uint8_t type, const uint8_t *data, size_t len) {
  uint8_t p[6 + 3 + 255 + 2];
  if (len > 255) return;
  memcpy(p, "IMPROV", 6);
  p[6] = 1;
  p[7] = type;
  p[8] = (uint8_t) len;
  memcpy(p + 9, data, len);
  uint8_t sum = 0;
  for (size_t i = 0; i < 9 + len; i++) sum += p[i];
  p[9 + len] = sum;
  p[10 + len] = '\n';
  port_write(p, 11 + len);
}

static void
send_byte (uint8_t type, uint8_t b) {
  send_packet(type, &b, 1);
}

// an RPC result: the command, then its strings, each with its length
static void
send_result (uint8_t cmd, const char *const *strings, size_t n) {
  uint8_t d[255];
  size_t len = 2;
  d[0] = cmd;
  for (size_t i = 0; i < n; i++) {
    size_t l = strnlen(strings[i], 64);
    if (len + 1 + l > sizeof(d)) break;
    d[len++] = (uint8_t) l;
    memcpy(d + len, strings[i], l);
    len += l;
  }
  d[1] = (uint8_t) (len - 2);
  send_packet(TYPE_RESULT, d, len);
}

static uint8_t
state_now (void) {
  return boat_wifi_connected() ? STATE_PROVISIONED : STATE_READY;
}

static void
scan (void) {
  scanning = true;
  xTimerStop(retry, 0);
  bool was = boat_wifi_connected();
  if (!was) esp_wifi_disconnect(); // a station still trying to join cannot scan
  uint16_t n = 0;
  wifi_ap_record_t *aps = NULL;
  if (esp_wifi_scan_start(NULL, true) == ESP_OK && esp_wifi_scan_get_ap_num(&n) == ESP_OK && n > 0) {
    if (n > 20) n = 20;
    aps = calloc(n, sizeof(*aps));
    if (!aps || esp_wifi_scan_get_ap_records(&n, aps) != ESP_OK) n = 0;
  } else {
    esp_wifi_clear_ap_list();
  }
  for (uint16_t i = 0; i < n; i++) {
    if (!aps[i].ssid[0]) continue;
    char rssi[8];
    snprintf(rssi, sizeof(rssi), "%d", aps[i].rssi);
    const char *s[] = { (const char *) aps[i].ssid, rssi, aps[i].authmode == WIFI_AUTH_OPEN ? "NO" : "YES" };
    send_result(RPC_SCAN, s, 3);
  }
  free(aps);
  send_result(RPC_SCAN, NULL, 0); // the end of the list
  scanning = false;
  if (!was) connect_now(NULL);
}

static void
rpc (const uint8_t *d, size_t len) {
  if (len < 2 || d[1] != len - 2) {
    send_byte(TYPE_ERROR, ERR_BAD_PACKET);
    return;
  }
  const uint8_t *p = d + 2;
  size_t plen = len - 2;
  switch (d[0]) {
  case RPC_WIFI: {
    size_t sl = plen > 0 ? p[0] : 0;
    size_t pl = plen > 1 + sl ? p[1 + sl] : 0;
    if (plen < 2 || sl > 32 || 2 + sl > plen || pl > 64 || 2 + sl + pl > plen) {
      send_byte(TYPE_ERROR, ERR_BAD_PACKET);
      return;
    }
    char s[33] = "", pw[65] = "";
    memcpy(s, p + 1, sl);
    memcpy(pw, p + 2 + sl, pl);
    send_byte(TYPE_ERROR, ERR_NONE);
    send_byte(TYPE_STATE, STATE_PROVISIONING);
    bool ok = s[0] && try_network(s, pw, PROVISION_WAIT_MS);
    memset(pw, 0, sizeof(pw));
    if (!ok) {
      send_byte(TYPE_ERROR, ERR_NO_CONNECT);
      send_byte(TYPE_STATE, STATE_READY);
      return;
    }
    send_byte(TYPE_STATE, STATE_PROVISIONED);
    send_result(RPC_WIFI, NULL, 0);
    return;
  }
  case RPC_STATE:
    send_byte(TYPE_STATE, state_now());
    if (state_now() == STATE_PROVISIONED) send_result(RPC_STATE, NULL, 0);
    return;
  case RPC_INFO: {
    const esp_app_desc_t *app = esp_app_get_description();
    const char *s[] = {
      config.firmware ? config.firmware : app->project_name,
      config.version ? config.version : app->version,
      CHIP_FAMILY,
      config.device_name ? config.device_name : (config.firmware ? config.firmware : app->project_name),
    };
    send_result(RPC_INFO, s, 4);
    return;
  }
  case RPC_SCAN:
    scan();
    return;
  default:
    send_byte(TYPE_ERROR, ERR_UNKNOWN_RPC);
  }
}

static void
improv_task (void *arg) {
  (void) arg;
  static uint8_t pkt[6 + 3 + 255 + 1];
  static char line[512];
  size_t pos = 0, llen = 0;
  bool lover = false;
  uint8_t buf[64];
  for (;;) {
    int n = port_read(buf, sizeof(buf));
    for (int i = 0; i < n; i++) {
      uint8_t c = buf[i];
      // every byte also goes to the text line; a whole Improv packet clears it
      if (c == '\n' || c == '\r') {
        line[llen] = '\0';
        if (llen && !lover && config.on_line) config.on_line(line, config.ctx);
        llen = 0;
        lover = false;
      } else if (llen < sizeof(line) - 1) {
        line[llen++] = (char) c;
      } else {
        lover = true;
      }
      if (pos < 6) {
        if (c == (uint8_t) "IMPROV"[pos]) pkt[pos++] = c;
        else pos = c == 'I' ? (pkt[0] = c, 1) : 0;
        continue;
      }
      pkt[pos++] = c;
      if (pos == 7 && c != 1) { pos = 0; continue; } // only version 1
      if (pos < 9 || pos < 9 + (size_t) pkt[8] + 1) continue;
      size_t len = pkt[8];
      uint8_t sum = 0;
      for (size_t j = 0; j < 9 + len; j++) sum += pkt[j];
      if (sum != pkt[9 + len]) send_byte(TYPE_ERROR, ERR_BAD_PACKET);
      else if (pkt[7] == TYPE_RPC) rpc(pkt + 9, len);
      memset(pkt, 0, sizeof(pkt));
      pos = 0;
      llen = 0;
    }
  }
}

static esp_err_t
improv_start (void) {
#if CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG
  if (!usb_serial_jtag_is_driver_installed()) {
    usb_serial_jtag_driver_config_t c = { .rx_buffer_size = 512, .tx_buffer_size = 1024 };
    esp_err_t err = usb_serial_jtag_driver_install(&c);
    if (err != ESP_OK) return err;
  }
  usb_serial_jtag_vfs_use_driver();
#else
  if (!uart_is_driver_installed(CONFIG_ESP_CONSOLE_UART_NUM)) {
    esp_err_t err = uart_driver_install(CONFIG_ESP_CONSOLE_UART_NUM, 512, 1024, 0, NULL, 0);
    if (err != ESP_OK) return err;
  }
  uart_vfs_dev_use_driver(CONFIG_ESP_CONSOLE_UART_NUM);
#endif
  return xTaskCreate(improv_task, "improv", 4096, NULL, 5, NULL) == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}

#endif

esp_err_t
boat_wifi_start (const boat_wifi_config_t *cfg) {
  if (events) return ESP_ERR_INVALID_STATE;
  config = *cfg;
  events = xEventGroupCreate();
  retry = xTimerCreate("wifi_retry", pdMS_TO_TICKS(1000), pdFALSE, NULL, connect_now);
  if (!events || !retry) return ESP_ERR_NO_MEM;
  load();
  esp_netif_create_default_wifi_sta();
  wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
  ESP_RETURN_ON_ERROR(esp_wifi_init(&init), TAG, "esp_wifi_init");
  esp_wifi_set_storage(WIFI_STORAGE_RAM); // the network lives in our namespace, not the driver's
  esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, NULL);
  esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_event, NULL);
  esp_wifi_set_mode(WIFI_MODE_STA);
  apply(ssid, password);
  ESP_RETURN_ON_ERROR(esp_wifi_start(), TAG, "esp_wifi_start");
  if (!ssid[0]) ESP_LOGI(TAG, "no Wi-Fi network set: waiting for one over Improv (ESP Web Tools)");
#if IMPROV_PORT
  if (!config.no_improv) return improv_start();
#endif
  return ESP_OK;
}

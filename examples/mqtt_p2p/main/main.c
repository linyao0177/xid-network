// MQTT over HyperDHT: an ESP32 device on a network of MQTT nodes anyone can run.
//
// - The device's key pair comes from a seed kept in NVS. Its public key is its
//   identity: the node checks it in the Noise handshake, so there is no
//   password, and only this device may publish under d/<its key>/.
// - esp-mqtt runs unchanged; components/hdht_mqtt gives it a transport that
//   looks the network up on HyperDHT and dials a node by public key.
// - Every few seconds the device publishes telemetry to d/<key>/telemetry.
//   It subscribes to its inbox, d/+/to/<key>/#, where the + is the key of
//   whoever sent the message (the node guarantees it), and acknowledges each
//   message to its sender.
// - Telemetry is signed with the device key (CONFIG_MQTT_P2P_SIGN), so an app
//   can check it whatever node or bridge it came through.
// - A simulated meter (CONFIG_MQTT_P2P_METER): a load of CONFIG_MQTT_P2P_LOAD_W
//   behind a relay. Telemetry carries the energy delivered so far, "mwh"
//   (milliwatt-hours, counting only while the relay is on), and "relay".
//   Only the owner (CONFIG_MQTT_P2P_OWNER, a public key) switches the relay,
//   with "on" or "off" to d/<owner>/to/<device>/relay. Bills are computed from
//   the signed readings by compute nodes (packages/boat-registry).
// - Node list (CONFIG_MQTT_P2P_VERIFIERS): the device reads the records of the
//   verifiers it trusts and connects only to the staked nodes a quorum of
//   them lists (components/hdht_mqtt nodelist), every 10 minutes again.
// - Each time it connects, the device puts its record on the DHT naming that
//   node as its home: {"v":1,"did":"did:mw:<key>","mqtt":"<node key>"}. A node
//   that gets a subscription to the device follows it there, and apps send it
//   messages at its home (packages/boat-mqtt-node).

#include <stdio.h>
#include <string.h>

#include "esp_event.h"
#include "esp_heap_caps.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mqtt_client.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "protocol_examples_common.h"

#include "hdht.h"
#include "hdht_mqtt.h"
#include "driver/gpio.h"

static uv_loop_t loop;
static hdht_t dht;
static uint8_t seed[32];
static uint8_t pk[32], sk[64]; // sk signs telemetry and the record
static char me[65]; // our public key in hex
static uint32_t boot; // signed sequence numbers: boot << 32 | count
static uv_async_t home_async;
static uv_timer_t republish;
static uint8_t home[32];       // set on esp-mqtt's task, read on the hdht task
static volatile bool home_set;
static uint64_t record_seq;
static esp_mqtt_client_handle_t mqtt;
static esp_transport_handle_t transport;
static volatile bool connected;
static volatile uint32_t sent_ok; // signed telemetry the client took, this boot
static volatile bool relay_on = true;
#if CONFIG_MQTT_P2P_METER
static uint64_t mwh; // energy delivered, the telemetry task only
static uint8_t owner[32];
static bool has_owner;
#endif
static volatile uint64_t last_seq;
static bool mqtt_started;

// Loads the 32-byte key seed from NVS, creating it on first boot, and counts
// boots (for rising sequence numbers).
static esp_err_t
load_seed (uint8_t out[32]) {
  nvs_handle_t nvs;
  esp_err_t err = nvs_open("mqtt_p2p", NVS_READWRITE, &nvs);
  if (err != ESP_OK) return err;
  size_t len = 32;
  err = nvs_get_blob(nvs, "seed", out, &len);
  if (err == ESP_ERR_NVS_NOT_FOUND) {
    randombytes_buf(out, 32);
    err = nvs_set_blob(nvs, "seed", out, 32);
  }
  nvs_get_u32(nvs, "boot", &boot);
  boot++;
  nvs_set_u32(nvs, "boot", boot);
  nvs_get_u64(nvs, "rec_seq", &record_seq);
  if (err == ESP_OK) err = nvs_commit(nvs);
  nvs_close(nvs);
  return err;
}

// the hdht task: our record, naming our home node

static void
on_put (hdht_t *d, int status, unsigned stored, void *data) {
  (void) d;
  (void) data;
  printf("MQTT|home record put status=%d nodes=%u seq=%llu\n", status, stored, (unsigned long long) record_seq);
}

static void
put_record (void) {
  char node[65], value[200];
  sodium_bin2hex(node, sizeof(node), home, 32);
  int len = snprintf(value, sizeof(value), "{\"v\":1,\"did\":\"did:mw:%s\",\"mqtt\":\"%s\"}", me, node);
  record_seq++;
  nvs_handle_t nvs;
  if (nvs_open("mqtt_p2p", NVS_READWRITE, &nvs) == ESP_OK) {
    nvs_set_u64(nvs, "rec_seq", record_seq);
    nvs_commit(nvs);
    nvs_close(nvs);
  }
  hdht_mutable_put(&dht, pk, sk, record_seq, (const uint8_t *) value, (size_t) len, on_put, NULL);
}

static void
on_home (uv_async_t *h) {
  (void) h;
  static uint8_t published[32];
  static bool once;
  if (!home_set || (once && memcmp(published, home, 32) == 0)) return; // the same home again
  memcpy(published, home, 32);
  once = true;
  put_record();
}

static void
on_republish (uv_timer_t *t) { // records live 48 h on the DHT
  (void) t;
  if (home_set) put_record();
}

static unsigned
uptime_s (void) {
  return (unsigned) (esp_timer_get_time() / 1000000);
}

// esp-mqtt's task
static void
on_mqtt (void *arg, esp_event_base_t base, int32_t id, void *data) {
  (void) arg;
  (void) base;
  esp_mqtt_event_handle_t e = data;
  char topic[200];

  switch ((esp_mqtt_event_id_t) id) {
  case MQTT_EVENT_CONNECTED: {
    connected = true;
    hdht_mqtt_info_t info;
    hdht_mqtt_get_info(transport, &info);
    char node[17];
    sodium_bin2hex(node, sizeof(node), info.node, 8);
    printf("MQTT|connected node=%s... found=%u lookup_ms=%u connect_ms=%u relayed=%d connects=%u\n", node, (unsigned) info.nodes_found, (unsigned) info.lookup_ms, (unsigned) info.connect_ms, info.relayed, (unsigned) info.connects);
    snprintf(topic, sizeof(topic), "d/+/to/%s/#", me);
    esp_mqtt_client_subscribe(mqtt, topic, 1);
    memcpy(home, info.node, 32);
    home_set = true;
    uv_async_send(&home_async); // the record is put on the hdht task
    break;
  }
  case MQTT_EVENT_DISCONNECTED:
    connected = false;
    printf("MQTT|disconnected\n");
    break;
  case MQTT_EVENT_SUBSCRIBED:
    printf("MQTT|subscribed to the inbox\n");
    break;
  case MQTT_EVENT_DATA: {
    // d/<sender>/to/<me>/<rest>
    int n = e->topic_len < (int) sizeof(topic) - 1 ? e->topic_len : (int) sizeof(topic) - 1;
    memcpy(topic, e->topic, n);
    topic[n] = 0;
    if (n < 2 + 64 + 4 || strncmp(topic, "d/", 2) != 0) break;
    char sender[65];
    memcpy(sender, topic + 2, 64);
    sender[64] = 0;
    // a receipt from the node we are on: what it signs it got from us
    hdht_mqtt_info_t info;
    hdht_mqtt_get_info(transport, &info);
    char node_hex[65];
    sodium_bin2hex(node_hex, sizeof(node_hex), info.node, 32);
    size_t rest_len = strlen(topic + 2 + 64 + 1);
    if (strcmp(sender, node_hex) == 0 && rest_len > 8 && strcmp(topic + n - 8, "/receipt") == 0) {
      hdht_mqtt_receipt_t r;
      uint64_t covered = 0, beyond = 0, lo = (uint64_t) boot << 32;
      bool ok = hdht_mqtt_receipt_open(info.node, pk, e->data, e->data_len, &r) == 0 &&
                hdht_mqtt_receipt_check(e->data, e->data_len, lo, sent_ok ? last_seq : lo, &covered, &beyond) == 0;
      if (!sent_ok) covered = 0;
      printf("MQTT|receipt from node %.12s...: %s, node counts %llu msgs %llu bytes; covers %llu of the %u we sent this boot%s\n", sender, ok ? "signature ok" : "BAD",
             (unsigned long long) r.count, (unsigned long long) r.bytes, (unsigned long long) covered, (unsigned) sent_ok,
             beyond ? ", and CLAIMS MESSAGES WE NEVER SENT" : "");
      break;
    }
    printf("MQTT|message from=%.12s... topic=%s payload=%.*s\n", sender, topic + 2 + 64 + 1, e->data_len, e->data);
#if CONFIG_MQTT_P2P_METER
    // the relay: only the owner switches it
    if (rest_len > 6 && strcmp(topic + n - 6, "/relay") == 0) {
      uint8_t from[32];
      bool is_owner = has_owner && sodium_hex2bin(from, 32, sender, 64, NULL, NULL, NULL) == 0 && memcmp(from, owner, 32) == 0;
      if (!is_owner) {
        printf("METER|relay command from %.12s... refused: not the owner\n", sender);
        break;
      }
      if (e->data_len == 2 && memcmp(e->data, "on", 2) == 0) relay_on = true;
      else if (e->data_len == 3 && memcmp(e->data, "off", 3) == 0) relay_on = false;
      printf("METER|relay %s by the owner\n", relay_on ? "ON" : "OFF");
#if CONFIG_MQTT_P2P_RELAY_GPIO >= 0
      gpio_set_level(CONFIG_MQTT_P2P_RELAY_GPIO, relay_on);
#endif
    }
#endif

    char reply_topic[200], reply[160];
    snprintf(reply_topic, sizeof(reply_topic), "d/%s/to/%s/ack", me, sender);
    int len = snprintf(reply, sizeof(reply), "ack:%.*s", e->data_len > 100 ? 100 : e->data_len, e->data);
    esp_mqtt_client_publish(mqtt, reply_topic, reply, len, 1, 0);
    break;
  }
  case MQTT_EVENT_ERROR:
    printf("MQTT|error type=%d\n", e->error_handle ? e->error_handle->error_type : -1);
    break;
  default:
    break;
  }
}

// another task: never calls hdht; esp-mqtt hands the bytes to the hdht task
static void
telemetry_task (void *arg) {
  (void) arg;
  char topic[100], msg[128];
  uint8_t sealed[128 + HDHT_MQTT_SIGNED_OVERHEAD];
  snprintf(topic, sizeof(topic), "d/%s/telemetry", me);
  unsigned seq = 0;
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(CONFIG_MQTT_P2P_INTERVAL * 1000));
    if (!connected) continue;
#if CONFIG_MQTT_P2P_METER
    if (relay_on) mwh += (uint64_t) CONFIG_MQTT_P2P_LOAD_W * CONFIG_MQTT_P2P_INTERVAL * 1000 / 3600; // W x s -> mWh
    int len = snprintf(msg, sizeof(msg), "{\"seq\":%u,\"mwh\":%llu,\"relay\":%d,\"uptime\":%u}", seq, (unsigned long long) mwh, relay_on, uptime_s());
#else
    int len = snprintf(msg, sizeof(msg), "{\"seq\":%u,\"uptime\":%u,\"heap\":%u}", seq, uptime_s(), (unsigned) heap_caps_get_free_size(MALLOC_CAP_8BIT));
#endif
#if CONFIG_MQTT_P2P_SIGN
    int64_t t0 = esp_timer_get_time();
    uint64_t s = ((uint64_t) boot << 32) | seq;
    int n = hdht_mqtt_sign(sk, topic, s, (const uint8_t *) msg, (size_t) len, sealed, sizeof(sealed));
    unsigned sign_us = (unsigned) (esp_timer_get_time() - t0);
    int id = esp_mqtt_client_publish(mqtt, topic, (const char *) sealed, n, 1, 0);
    if (id >= 0) {
      last_seq = s;
      sent_ok++;
    }
    printf("MQTT|telemetry seq=%u msg_id=%d signed in %u us\n", seq++, id, sign_us);
#else
    int id = esp_mqtt_client_publish(mqtt, topic, msg, len, 1, 0);
    printf("MQTT|telemetry seq=%u msg_id=%d\n", seq++, id);
#endif
  }
}

// the hdht task from here

static void
start_mqtt (void) {
  if (mqtt_started) return;
  mqtt_started = true;
  esp_mqtt_client_config_t cfg = {
    .broker.address.hostname = CONFIG_MQTT_P2P_NODE,
    .network.transport = transport,
    .network.timeout_ms = 30000, // a lookup and a holepunch, not a TCP handshake
    .network.reconnect_timeout_ms = 5000,
    .credentials.client_id = me, // the node wants it to start with our key
    .session.keepalive = 60,
  };
  mqtt = esp_mqtt_client_init(&cfg);
  esp_mqtt_client_register_event(mqtt, ESP_EVENT_ANY_ID, on_mqtt, NULL);
  esp_mqtt_client_start(mqtt);
  printf("MQTT|starting, node %s\n", CONFIG_MQTT_P2P_NODE);

  xTaskCreate(telemetry_task, "telemetry", 3072, NULL, 4, NULL);
}

static void
on_list_ready (bool taken, void *data) {
  (void) taken;
  (void) data;
  start_mqtt(); // without a list, the transport looks the network name up
}

static void
on_ready (hdht_t *d, int status) {
  printf("bootstrapped (status %d, %u nodes)\n", status, d->table_len);

  transport = hdht_mqtt_transport_new(d, NULL);
  if (transport == NULL) {
    printf("hdht_mqtt_transport_new failed\n");
    return;
  }
  // the node list (CONFIG_MQTT_P2P_VERIFIERS): our key picks the page, so
  // devices spread over the listed nodes; esp-mqtt starts once it is read
  uint32_t pick = ((uint32_t) pk[0] << 24) | ((uint32_t) pk[1] << 16) | ((uint32_t) pk[2] << 8) | pk[3];
  if (hdht_mqtt_nodelist_keep(d, transport, "mqtt_p2p", CONFIG_MQTT_P2P_VERIFIERS, pick, on_list_ready, NULL) != 0) start_mqtt();
}

static void
hdht_task (void *arg) {
  (void) arg;
  uv_loop_init(&loop);

  hdht_opts_t opts = { .seed = seed }; // the default key pair: our identity on the nodes
  if (hdht_init(&dht, &loop, &opts) != 0) {
    printf("hdht_init failed\n");
    vTaskDelete(NULL);
  }
  sodium_memzero(seed, sizeof(seed));

  esp_netif_ip_info_t ip;
  esp_netif_t *netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
  if (netif && esp_netif_get_ip_info(netif, &ip) == ESP_OK) hdht_add_local_address(&dht, (const uint8_t *) &ip.ip.addr);

  uv_async_init(&loop, &home_async, on_home);
  uv_timer_init(&loop, &republish);
  uv_timer_start(&republish, on_republish, 12 * 3600 * 1000, 12 * 3600 * 1000);
  hdht_bootstrap(&dht, on_ready);
  uv_run(&loop, UV_RUN_DEFAULT);
}

void
app_main (void) {
  esp_err_t err = nvs_flash_init();
  if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_ERROR_CHECK(nvs_flash_erase());
    err = nvs_flash_init();
  }
  ESP_ERROR_CHECK(err);
  if (sodium_init() < 0) return;

  ESP_ERROR_CHECK(load_seed(seed));
#if CONFIG_MQTT_P2P_METER
  has_owner = strlen(CONFIG_MQTT_P2P_OWNER) == 64 && sodium_hex2bin(owner, 32, CONFIG_MQTT_P2P_OWNER, 64, NULL, NULL, NULL) == 0;
  printf("METER|load %d W behind a relay, owner %s\n", CONFIG_MQTT_P2P_LOAD_W, has_owner ? CONFIG_MQTT_P2P_OWNER : "(none: nobody can switch it)");
#if CONFIG_MQTT_P2P_RELAY_GPIO >= 0
  gpio_reset_pin(CONFIG_MQTT_P2P_RELAY_GPIO);
  gpio_set_direction(CONFIG_MQTT_P2P_RELAY_GPIO, GPIO_MODE_OUTPUT);
  gpio_set_level(CONFIG_MQTT_P2P_RELAY_GPIO, 1);
#endif
#endif
  hdht_keypair(pk, sk, seed);
  sodium_bin2hex(me, sizeof(me), pk, 32);
  printf("MQTT|device key %s\n", me);

  ESP_ERROR_CHECK(esp_netif_init());
  ESP_ERROR_CHECK(esp_event_loop_create_default());
  ESP_ERROR_CHECK(example_connect());

  xTaskCreate(hdht_task, "hdht", 20480, NULL, 5, NULL);
}

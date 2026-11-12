// boat_depin (see include/boat_depin.h)

#include <stdio.h>
#include <string.h>
#include <sys/time.h>

#include "cJSON.h"
#include "esp_log.h"
#include "esp_now.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "sodium.h"

#include "boat_depin.h"
#include "boat_device.h"

static const char *TAG = "boat_depin";

#define MAGIC "XDB1"
#define FRAME_LEN (4 + 32 + 32 + 8 + 64)
#define HEARD_MAX 16     // beacons kept for the slot (and the next)
#define REPORT_MAX 5     // beacons in one witness report (it stays under 1.5 kB)
#define REJOIN_MS (30 * 60 * 1000)
#define PING_MAX 256     // bytes of a ping: { net, nonce } is under 170
#define PING_DEPTH 2     // and it is flat
#define QUEUE_LEN 16
#define QUEUE_KEEP 4     // places in the queue beacons never take: pings and connects

static const char BEACON[] = "xid-depin-beacon/1"; // and its 0 byte

typedef enum { EV_PING = 1, EV_CONNECTED, EV_BEACON } ev_kind_t;

typedef struct {
  uint8_t kind;
  int8_t rssi;
  char nonce[65];
  uint8_t frame[FRAME_LEN];
} ev_t;

typedef struct {
  uint8_t from[32];
  int64_t slot;
  uint8_t sig[64];
  int rssi;
} heard_t;

static boat_depin_config_t cfg;
static char net_hex[65], cell[24], payee[43], topic[48], join_name[96], pong_name[96], witness_name[96];
static uint8_t net[32], me[32];
static QueueHandle_t queue;
static volatile bool started;
static boat_depin_stats_t stats;
static heard_t heard[HEARD_MAX];
static size_t heard_len;

static int64_t
now_ms (void) {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return (int64_t) tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

static bool
clock_set (void) {
  return now_ms() > 1700000000000LL;
}

int64_t
boat_depin_slot (void) {
  if (!started || !clock_set()) return -1;
  int64_t s = now_ms() / 1000;
  return s < cfg.start ? -1 : (s - cfg.start) / cfg.slot_seconds;
}

// "xid-depin-beacon/1" 0 | net | device | slot (big-endian)
static void
beacon_bytes (const uint8_t did[32], int64_t slot, uint8_t out[sizeof(BEACON) + 72]) {
  memcpy(out, BEACON, sizeof(BEACON));
  memcpy(out + sizeof(BEACON), net, 32);
  memcpy(out + sizeof(BEACON) + 32, did, 32);
  for (int i = 0; i < 8; i++) out[sizeof(BEACON) + 64 + i] = (uint8_t) ((uint64_t) slot >> (56 - 8 * i));
}

// ---- what the device publishes ----

static esp_err_t
publish_join (void) {
  char body[200];
  int n = snprintf(body, sizeof(body), "{\"v\":1,\"net\":\"%s\",\"cell\":\"%s\",\"payee\":\"%s\"", net_hex, cell, payee);
  if (cfg.rated) n += snprintf(body + n, sizeof(body) - n, ",\"rated\":%lu", (unsigned long) cfg.rated);
  n += snprintf(body + n, sizeof(body) - n, "}");
  esp_err_t err = boat_device_publish_retained(join_name, body, (size_t) n);
  if (err == ESP_OK) {
    stats.joins++;
    ESP_LOGI(TAG, "join record: cell %s, payee %s", cell, payee);
  }
  return err;
}

static void
publish_pong (const char *nonce) {
  char body[100];
  int n = snprintf(body, sizeof(body), "{\"v\":1,\"nonce\":\"%s\"}", nonce);
  if (boat_device_publish(pong_name, body, (size_t) n) == ESP_OK) stats.pongs++;
}

esp_err_t
boat_depin_reading (const char *members) {
  if (!started) return ESP_ERR_INVALID_STATE;
  if (!clock_set()) return ESP_ERR_INVALID_STATE; // ts would be wrong
  char body[256];
  int n = snprintf(body, sizeof(body), "{%s%s\"ts\":%lld}", members, members[0] ? "," : "", (long long) (now_ms() / 1000));
  if (n < 0 || n >= (int) sizeof(body)) return ESP_ERR_INVALID_SIZE;
  esp_err_t err = boat_device_publish(topic, body, (size_t) n);
  if (err == ESP_OK) stats.readings++;
  return err;
}

// ---- the radio ----

static const uint8_t BROADCAST[6] = { 0xff, 0xff, 0xff, 0xff, 0xff, 0xff };

static void
on_espnow (const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  // the Wi-Fi task: only a quick look, the signature is checked on ours
  if (len != FRAME_LEN || memcmp(data, MAGIC, 4) != 0 || memcmp(data + 4, net, 32) != 0) return;
  if (uxQueueSpacesAvailable(queue) <= QUEUE_KEEP) return; // a flood of frames must not push the pings out
  ev_t ev = { .kind = EV_BEACON, .rssi = info->rx_ctrl ? (int8_t) info->rx_ctrl->rssi : 0 };
  memcpy(ev.frame, data, FRAME_LEN);
  xQueueSend(queue, &ev, 0);
}

static void
send_beacon (int64_t slot) {
  uint8_t frame[FRAME_LEN], msg[sizeof(BEACON) + 72];
  memcpy(frame, MAGIC, 4);
  memcpy(frame + 4, net, 32);
  memcpy(frame + 36, me, 32);
  for (int i = 0; i < 8; i++) frame[68 + i] = (uint8_t) ((uint64_t) slot >> (56 - 8 * i));
  beacon_bytes(me, slot, msg);
  if (boat_device_sign(msg, sizeof(msg), frame + 76) != ESP_OK) return;
  if (esp_now_send(BROADCAST, frame, FRAME_LEN) == ESP_OK) stats.beacons_sent++;
}

esp_err_t
boat_depin_beacon_json (char *out, size_t size) {
  int64_t slot = boat_depin_slot();
  if (slot < 0) return ESP_ERR_INVALID_STATE;
  uint8_t msg[sizeof(BEACON) + 72], sig[64];
  beacon_bytes(me, slot, msg);
  if (boat_device_sign(msg, sizeof(msg), sig) != ESP_OK) return ESP_FAIL;
  char from[65], sig_hex[129];
  sodium_bin2hex(from, sizeof(from), me, 32);
  sodium_bin2hex(sig_hex, sizeof(sig_hex), sig, 64);
  int n = snprintf(out, size, "{\"from\":\"%s\",\"slot\":%lld,\"sig\":\"%s\"}", from, (long long) slot, sig_hex);
  return n > 0 && n < (int) size ? ESP_OK : ESP_ERR_INVALID_SIZE;
}

static void
take_beacon (const ev_t *ev, int64_t slot) {
  const uint8_t *from = ev->frame + 36;
  int64_t s = 0;
  for (int i = 0; i < 8; i++) s = (s << 8) | ev->frame[68 + i];
  if (memcmp(from, me, 32) == 0) return;
  if (s != slot && s != slot + 1) return; // stale, or from too far ahead
  for (size_t i = 0; i < heard_len; i++) if (heard[i].slot == s && memcmp(heard[i].from, from, 32) == 0) return; // a repeat
  // Where it goes. A full table keeps the strongest (those are reported), so
  // whoever comes first with many keys cannot keep the others out; a weaker
  // one is dropped before its signature costs anything, repeats included.
  heard_t *h = &heard[heard_len < HEARD_MAX ? heard_len : 0];
  if (heard_len == HEARD_MAX) {
    for (size_t i = 1; i < HEARD_MAX; i++) if (heard[i].rssi < h->rssi) h = &heard[i];
    if (ev->rssi <= h->rssi) return;
  }
  uint8_t msg[sizeof(BEACON) + 72];
  beacon_bytes(from, s, msg);
  if (crypto_sign_verify_detached(ev->frame + 76, msg, sizeof(msg), from) != 0) {
    stats.beacons_bad++;
    return;
  }
  stats.beacons_heard++;
  if (heard_len < HEARD_MAX) heard_len++;
  memcpy(h->from, from, 32);
  h->slot = s;
  memcpy(h->sig, ev->frame + 76, 64);
  h->rssi = ev->rssi;
}

// what it heard in a slot that is over: one report, the strongest first
static void
report (int64_t slot) {
  heard_t *mine[HEARD_MAX];
  size_t n = 0;
  for (size_t i = 0; i < heard_len; i++) if (heard[i].slot == slot) mine[n++] = &heard[i];
  for (size_t i = 1; i < n; i++) // strongest first
    for (size_t j = i; j > 0 && mine[j]->rssi > mine[j - 1]->rssi; j--) {
      heard_t *t = mine[j];
      mine[j] = mine[j - 1];
      mine[j - 1] = t;
    }
  if (n > REPORT_MAX) n = REPORT_MAX;
  if (n) {
    static char body[64 + REPORT_MAX * 240];
    int len = snprintf(body, sizeof(body), "{\"v\":1,\"slot\":%lld,\"heard\":[", (long long) slot);
    for (size_t i = 0; i < n; i++) {
      char from[65], sig[129];
      sodium_bin2hex(from, sizeof(from), mine[i]->from, 32);
      sodium_bin2hex(sig, sizeof(sig), mine[i]->sig, 64);
      len += snprintf(body + len, sizeof(body) - len, "%s{\"from\":\"%s\",\"slot\":%lld,\"sig\":\"%s\",\"rssi\":%d}", i ? "," : "", from, (long long) slot, sig, mine[i]->rssi);
    }
    len += snprintf(body + len, sizeof(body) - len, "]}");
    if (boat_device_publish(witness_name, body, (size_t) len) == ESP_OK) {
      stats.witness_reports++;
      ESP_LOGI(TAG, "slot %lld: heard %u beacon(s), reported", (long long) slot, (unsigned) n);
    }
  }
  // keep only what is still to come
  size_t k = 0;
  for (size_t i = 0; i < heard_len; i++) if (heard[i].slot > slot) heard[k++] = heard[i];
  heard_len = k;
}

// ---- the task ----

static void
depin_task (void *arg) {
  (void) arg;
  bool join_due = true;
  int64_t joined_at = 0, slot = -1, beacon_at = 0;
  int beacons_left = 0;
  // where in a slot this device beacons: from its key, so neighbours spread out
  uint32_t spread = cfg.slot_seconds > 8 ? (cfg.slot_seconds / 2) * 1000 - 2000 : 1000;
  uint32_t offset = 2000 + (((uint32_t) me[0] << 16 | (uint32_t) me[1] << 8 | me[2]) % spread);
  for (;;) {
    ev_t ev;
    if (xQueueReceive(queue, &ev, pdMS_TO_TICKS(250)) == pdTRUE) {
      if (ev.kind == EV_PING) publish_pong(ev.nonce);
      else if (ev.kind == EV_CONNECTED) join_due = true;
      else if (ev.kind == EV_BEACON && slot >= 0) take_beacon(&ev, slot);
    }
    int64_t t = now_ms();
    if (!join_due && t - joined_at > REJOIN_MS) join_due = true;
    if (join_due && boat_device_connected() && publish_join() == ESP_OK) {
      join_due = false;
      joined_at = t;
    }
    int64_t s = boat_depin_slot();
    if (s != slot) {
      if (slot >= 0 && cfg.beacons) report(slot);
      slot = s;
      if (s >= 0 && cfg.beacons) {
        beacon_at = (cfg.start + s * (int64_t) cfg.slot_seconds) * 1000 + offset;
        beacons_left = 2; // twice, a moment apart: one may be lost
      }
    }
    if (beacons_left && t >= beacon_at && slot >= 0) {
      send_beacon(slot);
      beacons_left--;
      beacon_at = t + 400;
    }
  }
}

// Anyone may ping, and cJSON calls itself once for each level of nesting, on
// esp-mqtt's small stack: only what is as small and as flat as a ping is parsed.
static bool
ping_shape_ok (const uint8_t *data, size_t len) {
  if (len > PING_MAX) return false;
  int depth = 0;
  bool in_string = false;
  for (size_t i = 0; i < len; i++) {
    uint8_t c = data[i];
    if (in_string) {
      if (c == '\\') i++;
      else if (c == '"') in_string = false;
    } else if (c == '"') in_string = true;
    else if ((c == '{' || c == '[') && ++depth > PING_DEPTH) return false;
    else if ((c == '}' || c == ']') && depth > 0) depth--;
  }
  return true;
}

bool
boat_depin_message (const char *from_hex, const char *what, const uint8_t *data, size_t len) {
  (void) from_hex; // the node checked the sender; anyone may ping
  if (!started || strcmp(what, "depin-ping") != 0) return false;
  if (!ping_shape_ok(data, len)) return true;
  cJSON *m = cJSON_ParseWithLength((const char *) data, len);
  const cJSON *n = cJSON_GetObjectItem(m, "net");
  const cJSON *nonce = cJSON_GetObjectItem(m, "nonce");
  if (cJSON_IsString(n) && strcmp(n->valuestring, net_hex) == 0 && cJSON_IsString(nonce) && strlen(nonce->valuestring) <= 64) {
    bool ok = true; // it goes into JSON as it is: plain characters only
    for (const char *p = nonce->valuestring; *p; p++) if (*p == '"' || *p == '\\' || (unsigned char) *p < 0x20) ok = false;
    if (ok) {
      ev_t ev = { .kind = EV_PING };
      snprintf(ev.nonce, sizeof(ev.nonce), "%s", nonce->valuestring);
      xQueueSend(queue, &ev, 0);
    }
  }
  cJSON_Delete(m);
  return true;
}

void
boat_depin_connected (void) {
  if (!started) return;
  ev_t ev = { .kind = EV_CONNECTED };
  xQueueSend(queue, &ev, 0);
}

void
boat_depin_get_stats (boat_depin_stats_t *out) {
  *out = stats;
}

static bool
hex_ok (const char *s, size_t len) {
  if (!s || strlen(s) != len) return false;
  for (; *s; s++) if (!((*s >= '0' && *s <= '9') || (*s >= 'a' && *s <= 'f'))) return false;
  return true;
}

esp_err_t
boat_depin_start (const boat_depin_config_t *c) {
  if (started) return ESP_ERR_INVALID_STATE;
  if (!c || !hex_ok(c->net, 64) || !c->cell || strlen(c->cell) < 15 || strlen(c->cell) >= sizeof(cell) || !c->payee || strlen(c->payee) != 42 || strncmp(c->payee, "0x", 2) != 0 ||
      !c->topic || !c->topic[0] || strlen(c->topic) >= sizeof(topic) || c->slot_seconds == 0) return ESP_ERR_INVALID_ARG;
  const char *key = boat_device_key();
  if (!key || !hex_ok(key, 64)) return ESP_ERR_INVALID_STATE; // boat_device_start first
  cfg = *c;
  snprintf(net_hex, sizeof(net_hex), "%s", c->net);
  snprintf(cell, sizeof(cell), "%s", c->cell);
  snprintf(payee, sizeof(payee), "%s", c->payee);
  snprintf(topic, sizeof(topic), "%s", c->topic);
  sodium_hex2bin(net, 32, net_hex, 64, NULL, NULL, NULL);
  sodium_hex2bin(me, 32, key, 64, NULL, NULL, NULL);
  snprintf(join_name, sizeof(join_name), "depin/%s/join", net_hex);
  snprintf(pong_name, sizeof(pong_name), "depin/%s/pong", net_hex);
  snprintf(witness_name, sizeof(witness_name), "depin/%s/witness", net_hex);
  queue = xQueueCreate(QUEUE_LEN, sizeof(ev_t));
  if (!queue) return ESP_ERR_NO_MEM;
  if (c->beacons) {
    esp_err_t err = esp_now_init();
    if (err == ESP_OK) err = esp_now_register_recv_cb(on_espnow);
    esp_now_peer_info_t peer = { .channel = 0, .ifidx = WIFI_IF_STA, .encrypt = false };
    memcpy(peer.peer_addr, BROADCAST, 6);
    if (err == ESP_OK && !esp_now_is_peer_exist(BROADCAST)) err = esp_now_add_peer(&peer);
    if (err != ESP_OK) {
      ESP_LOGE(TAG, "ESP-NOW: %s", esp_err_to_name(err));
      return err;
    }
  }
  started = true;
  if (xTaskCreate(depin_task, "depin", 8192, NULL, 4, NULL) != pdPASS) return ESP_ERR_NO_MEM;
  ESP_LOGI(TAG, "network %.16s..., cell %s, slots of %lu s from %lld%s", net_hex, cell, (unsigned long) cfg.slot_seconds, (long long) cfg.start, cfg.beacons ? ", beacons" : "");
  return ESP_OK;
}

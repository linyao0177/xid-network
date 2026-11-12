// Places: H3 cells for where a device says it is, kilometres for what a
// round trip allows, and radio for what a witness can have heard.
//
// Decisions are made in integers where they can be (grid distances between
// cells), and kilometres and decibels are rounded, so every oracle comes to
// the same answer.

import * as h3 from 'h3-js'

export const cellOk = (cell, res) => typeof cell === 'string' && h3.isValidCell(cell) && h3.getResolution(cell) === res
export const cellAt = (lat, lon, res) => h3.latLngToCell(lat, lon, res)
export const centerOf = (cell) => h3.cellToLatLng(cell) // [lat, lon]
export const parentOf = (cell, res) => h3.cellToParent(cell, res)
export const gridDistance = (a, b) => {
  try { return h3.gridDistance(a, b) } catch { return Infinity } // too far apart (or across a pentagon)
}

// great-circle distance, whole kilometres
export function distanceKm (lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180
  const dLat = (lat2 - lat1) * rad
  const dLon = (lon2 - lon1) * rad
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2
  return Math.round(2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a))))
}

// light in fibre covers about 200 km in a millisecond: a round trip of rttMs
// puts the two ends at most kmPerMs * rttMs apart (100 km per ms of round
// trip). Queues and processing only make the round trip longer, so the bound
// holds whatever the path; it can rule a place out, never in.
export function latencyAllows ({ lat, lon }, cell, rttMs, { kmPerMs = 100, slackKm = 50 } = {}) {
  const [clat, clon] = centerOf(cell)
  return distanceKm(lat, lon, clat, clon) <= Math.ceil(rttMs * kmPerMs) + slackKm
}

// the strongest signal a witness can have heard from a transmitter `cells`
// grid steps away (free space at 2.4 GHz, from the nearest the two cells can
// be): anything stronger was not heard over that distance
export function maxRssi (cells, res, txDbm = 20) {
  if (cells <= 1) return 0 // neighbours or one cell: as close as you like
  const spacingM = h3.getHexagonEdgeLengthAvg(res, h3.UNITS.m) * Math.sqrt(3)
  const d = (cells - 1) * spacingM
  return Math.round(txDbm + 6 - (20 * Math.log10(d) + 40.2)) // +6: antenna gains at both ends
}

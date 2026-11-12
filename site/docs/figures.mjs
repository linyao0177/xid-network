// The figures of the docs' Architecture chapter, as HTML made at build time:
// docs.md names one with ![caption](fig:name) and build.mjs puts it in.
//
// Each is an SVG drawn on a 680-wide canvas (the text column is 780), in the
// template's colours. Four are scenes in steps: every part says in data-a and
// data-b the steps it shows in, the build marks the first step, and the
// template's script moves between them. Without script a scene is its first
// step, drawn whole.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// a box with a title and, under it, a line of small text
const B = (x, y, w, h, c, t, s) => `<rect class="b ${c}" x="${x}" y="${y}" width="${w}" height="${h}" rx="7"/><text class="th" x="${x + w / 2}" y="${s ? y + h / 2 - 9 : y + h / 2}">${esc(t)}</text>` + (s ? `<text class="ts" x="${x + w / 2}" y="${y + h / 2 + 10}">${esc(s)}</text>` : '')
const T = (x, y, t, c = 'ts', anchor = null) => `<text class="${c}" x="${x}" y="${y}"${anchor ? ` style="text-anchor:${anchor}"` : ''}>${esc(t)}</text>`
// a moving dashed line (rv: the other way), a ring around a box
const F = (d, k, rv) => `<path class="fl k-${k}${rv ? ' rv' : ''}" d="${d}"/>`
const R = (x, y, w, h, k) => `<rect class="ring k-${k}" x="${x}" y="${y}" width="${w}" height="${h}" rx="11"/>`
// what shows in steps a..b (the first step is marked here)
const G = (a, b, inner) => `<g class="st${a === 0 ? ' on' : ''}" data-a="${a}" data-b="${b}">${inner}</g>`

function svg (name, h, inner, title) {
  const id = 'ah-' + name
  const A = (x1, y1, x2, y2) => `<line class="ar" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#${id})"/>`
  return `<svg viewBox="0 0 680 ${h}" role="img" aria-label="${esc(title)}"><defs><marker id="${id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>${inner(A)}</svg>`
}

const legend = (items) => `<div class="xlegend">${items.map(([k, t]) => `<span><i class="l-${k}"></i>${esc(t)}</span>`).join('')}</div>`
const still = (name, h, inner, title, items) => `<div class="xfig"><div class="xscroll">${svg(name, h, inner, title)}</div>${items ? legend(items) : ''}</div>`

// steps: [[tab, title, text], ...]
function scene (name, h, inner, title, steps, items, extra = '') {
  return `<div class="xfig" data-scene><div class="xscroll">${svg(name, h, inner, title)}</div>${extra}${legend(items)}` +
    `<div class="xctl"><div class="xtabs" role="tablist" aria-label="Steps">${steps.map((s, k) => `<button type="button" role="tab" aria-selected="${k === 0}" data-title="${esc(s[1])}" data-text="${esc(s[2])}">${k + 1} ${esc(s[0])}</button>`).join('')}</div>` +
    `<div class="xsay"><div class="xtxt"><div class="xct">${esc(steps[0][1])}</div><div class="xcc" aria-live="polite">${esc(steps[0][2])}</div></div><div class="xnav"><button type="button" aria-label="Previous step">←</button><button type="button" aria-label="Next step">→</button></div></div></div></div>`
}

export const figures = {
  // the signed message, byte by byte
  message: () => `<div class="xfig"><div class="xscroll"><div class="xbytes" role="img" aria-label="A signed message: a marker and a version byte, an 8-byte sequence number, a 64-byte signature, then the payload">` +
    [[1.1, '0', "'S'", 'marker', ''], [1.1, '1', '01', 'version', ''], [3, '2', 'seq · 8', 'boot count, then a counter: it only rises', ''], [6, '10', 'Ed25519 signature · 64', 'over the topic, the sequence number and the payload', ' sig'], [5, '74', 'payload', 'the reading, sealed if the device wants', '']]
      .map(([f, off, box, what, c]) => `<div class="xseg${c}" style="flex:${f}"><div class="off">${off}</div><div class="box">${esc(box)}</div><div class="what">${esc(what)}</div></div>`).join('') +
    '</div></div></div>',

  layers: () => still('layers', 530, (A) =>
    B(60, 10, 240, 56, 'x', 'ESP32-C3 devices', 'sign every message') + B(380, 10, 240, 56, 'x', 'Apps and readers', 'subscribe, pay to read') +
    A(180, 66, 180, 112) + A(500, 112, 500, 74) +
    '<rect class="grp" x="40" y="120" width="600" height="220" rx="12"/>' +
    T(60, 144, 'STAKED NODES · BOAT-NODE', 'tm', 'start') + T(620, 144, 'MQTT over HyperDHT', 'ts', 'end') +
    B(60, 166, 125, 56, 'd', 'Forward', 'MQTT broker') + B(205, 166, 125, 56, 'd', 'Store', 'Hypercore logs') + B(350, 166, 125, 56, 'd', 'Verify', 'watchtower, audit') + B(495, 166, 125, 56, 'd', 'Compute', 'rules, oracles') +
    B(60, 252, 560, 56, 'd', 'Off-chain coordination', 'assignment plan · signed work messages · settler') +
    A(340, 340, 340, 382) +
    '<rect class="grp" x="40" y="390" width="600" height="120" rx="12"/>' + T(60, 414, 'CONTRACTS · ARC TESTNET', 'tm', 'start') +
    B(60, 434, 180, 56, 'c', 'BoatRegistry', 'stake, jobs, settle, slash') + B(250, 434, 180, 56, 'c', 'BoatReads', 'payment channels') + B(440, 434, 180, 56, 'c', 'DepinNetwork', 'epoch roots, claims'),
  'Three layers: devices and apps, staked nodes in four roles, three contracts',
  [['x', 'outside the network'], ['d', 'nodes'], ['c', 'contracts']]),

  job: () => still('job', 610, (A) =>
    T(115, 20, 'DEVICES, PAYERS', 'tm') + T(265, 20, 'ASSIGNED NODES', 'tm') + T(415, 20, 'VERIFIERS', 'tm') + T(565, 20, 'CONTRACTS', 'tm') +
    [190, 340, 490].map((x) => `<line class="lane" x1="${x}" y1="8" x2="${x}" y2="600"/>`).join('') +
    B(50, 44, 130, 48, 'x', '1 Post a job', 'budget, quorum') + A(180, 68, 492, 68) + B(500, 44, 130, 48, 'c', 'Record the job', 'take the job fee') +
    B(200, 114, 130, 48, 'd', '2 Plan', 'from chain events') + B(350, 114, 130, 48, 'd', 'Pick watchers', 'three per device') +
    B(50, 184, 130, 48, 'x', '3 Publish', 'signed, numbered') + A(180, 208, 192, 208) + B(200, 184, 130, 48, 'd', 'Forward, store', 'signed receipts') +
    B(200, 254, 130, 48, 'd', '4 Sign a unit', 'each on its own') + A(330, 278, 342, 278) + B(350, 254, 130, 48, 'd', 'Re-check work', 'against the device') +
    B(200, 324, 130, 48, 'd', '5 Settle', 'quorum reached') + A(330, 348, 492, 348) + B(500, 324, 130, 48, 'c', 'Verify, pay', 'from the budget') +
    B(500, 394, 130, 48, 'c', '6 Rewards wait', 'mature next epoch') + A(500, 418, 488, 418) + B(350, 394, 130, 48, 'd', 'Audit signers', 'against the plan') +
    B(350, 464, 130, 48, 'd', '7 Raise a fault', 'verifiers co-sign') + A(480, 488, 492, 488) + B(500, 464, 130, 48, 'c', 'Slash stake', 'and unripe rewards') +
    B(500, 534, 130, 48, 'c', 'Rewards mature', 'if not slashed') + A(500, 558, 338, 558) + B(200, 534, 130, 48, 'd', '8 Withdraw', 'automatic'),
  'Eight steps of a job across four lanes: devices and payers, assigned nodes, verifiers, contracts'),

  // each row one protocol, spoken at both ends
  stack: () => '<div class="xfig"><div class="xstack">' +
    '<div class="hd">ESP32-C3 · C</div><div></div><div class="hd">Node · Node.js</div>' +
    [['boat_device', 'signs, seals, checks receipts', 'boat-node roles', 'verify, store, sign receipts'],
      ['esp-mqtt', 'MQTT 3.1.1 client', 'Aedes', 'broker; identity is the key'],
      ['hdht_mqtt', 'esp_transport; picks a node', 'connection adapter', 'hands the stream to the broker'],
      ['Noise IK + SecretStream', 'handshake proves the key', 'Noise IK + SecretStream', "learns the peer's key"],
      ['libudx', 'reliable stream over UDP', 'UDX', 'the same protocol'],
      ['hdht', 'find by key, holepunch, relay', 'hyperdht 6.x', 'listen by key, announce']]
      .map(([a, b, c, d]) => `<div class="cell"><b>${esc(a)}</b><small>${esc(b)}</small></div><div class="peer"></div><div class="cell"><b>${esc(c)}</b><small>${esc(d)}</small></div>`).join('') +
    '<div class="cell wire"><b>uv_esp + lwIP</b><small>UDP on Wi-Fi, behind a NAT</small></div><div class="peer real"></div><div class="cell wire"><b>libuv</b><small>UDP</small></div>' +
    '</div></div>',

  link: () => scene('link', 290, (A) =>
    '<rect class="grp" x="30" y="96" width="212" height="170" rx="12"/>' + T(44, 116, 'HOME WI-FI', 'tm', 'start') +
    B(50, 150, 96, 60, 'x', 'ESP32-C3', 'holds the key') + B(180, 160, 50, 40, 'x', 'NAT') + '<line class="ar" x1="146" y1="180" x2="180" y2="180"/>' +
    T(340, 20, 'HYPERDHT', 'tm') +
    '<g class="dimmable f-muted" data-dim="1"><circle cx="290" cy="60" r="6"/><circle cx="325" cy="45" r="6"/><circle cx="360" cy="52" r="6"/><circle cx="392" cy="68" r="6"/><circle cx="308" cy="88" r="6"/><circle cx="345" cy="80" r="6"/><circle cx="378" cy="98" r="6"/></g>' +
    B(440, 150, 100, 60, 'd', 'Forward node', 'MQTT broker') + B(574, 92, 66, 44, 'd', 'Store') + B(574, 224, 66, 44, 'd', 'Verify') +
    G(0, 0, F('M205 160L300 96', 'link') + F('M210 160L338 90', 'link') + F('M215 160L370 106', 'link')) +
    G(1, 1, F('M210 160L338 90L470 150', 'link')) +
    G(2, 2, F('M230 180L440 180', 'link')) +
    G(3, 5, '<rect class="tube" x="230" y="168" width="210" height="24" rx="12"/><rect class="pk f-dev" x="234" y="174" width="34" height="12" rx="3"/>') +
    G(4, 4, '<rect class="rc f-chain" x="234" y="174" width="34" height="12" rx="3"/>' + R(436, 146, 108, 68, 'chain')) +
    G(5, 5, F('M540 165L574 122', 'dev') + F('M540 195L574 238', 'dev')),
  'A device finds a node through HyperDHT, holepunches and publishes a signed reading',
  [['Find', 'Find a node', 'The device asks HyperDHT for the node list its trusted verifiers signed, takes the one two thirds of them put out byte for byte, and picks a page of it by its own key.'],
    ['Handshake', 'Shake hands through the DHT', "DHT nodes pass the handshake on to the node. It is Noise IK with the device's identity key in it, so the node learns for certain whose connection this is."],
    ['Holepunch', 'Punch through the NAT', 'Both ends send UDP at each other at once, which opens a direct path through the home router. If it cannot be opened, a blind relay carries the stream. From here on nothing goes through the DHT.'],
    ['Publish', 'Publish on the encrypted stream', "A reliable, encrypted stream runs over that path, and MQTT inside it. Each reading carries the device's own signature and sequence number: the bytes are under the figure."],
    ['Receipt', 'The node answers with a receipt', 'The node checks that the topic belongs to this key. Now and then it signs a receipt: these are the sequence numbers I got from you. The device checks it against what it sent.'],
    ['Fan out', 'The assigned nodes come and listen', "The store and verify nodes assigned to this device's jobs subscribe to it at this node. Each checks the device's signature again before doing its work."]],
  [['link', 'making the connection'], ['dev', "the device's messages"], ['chain', "the node's receipt"]],
  `<div class="xfmt" data-a="3" data-b="5"><span>'S' 01</span><span>seq · 8 bytes</span><span class="s">signature · 64 bytes</span><span>payload</span></div>`),

  settle: () => scene('settle', 330, (A) =>
    B(40, 40, 110, 50, 'd', 'Node A', 'assigned') + B(40, 130, 110, 50, 'd', 'Node B', 'assigned') + B(40, 220, 110, 50, 'd', 'Node C', 'assigned') +
    B(250, 110, 130, 90, 'x', "The device's node", 'keeps work messages') +
    '<rect class="b c" x="490" y="80" width="150" height="150" rx="7"/>' + T(565, 100, 'BoatRegistry', 'th') + T(565, 128, 'job budget') + T(565, 178, 'rewards, not yet mature') +
    '<rect class="barframe" x="505" y="140" width="120" height="10" rx="5"/><rect class="xbar f-chain" x="505" y="140" width="120" height="10" rx="5" data-wat="4" data-w0="120" data-w1="96"/>' +
    B(250, 272, 130, 44, 'd', 'Verifier') +
    G(0, 1, [60, 150, 240].map((y) => [160, 172, 184, 196, 208].map((x) => `<rect class="f-dev" x="${x}" y="${y}" width="9" height="9" rx="2"/>`).join('')).join('')) +
    G(1, 1, F('M150 80L250 135', 'dev') + F('M150 170L250 165', 'dev') + F('M150 232L250 185', 'dev')) +
    G(1, 3, [262, 300, 338].map((x) => `<rect class="f-dev" x="${x}" y="178" width="30" height="13" rx="3"/>`).join('')) +
    G(2, 2, F('M150 80L250 135', 'link', 1) + F('M150 170L250 165', 'link', 1) + F('M150 232L250 185', 'link', 1)) +
    G(3, 3, F('M150 56L490 100', 'link') + '<rect class="f-link" x="-17" y="-7" width="34" height="14" rx="3"><animateMotion dur="2s" repeatCount="indefinite" path="M150 56L490 100"/></rect>') +
    G(4, 5, R(486, 76, 158, 158, 'chain') + [535, 565, 595].map((x) => `<circle class="f-chain" cx="${x}" cy="204" r="8"/>`).join('')) +
    G(5, 5, F('M490 222L380 290', 'chain') + F('M490 212L150 248', 'chain')),
  'Three nodes sign a result, collect signatures and settle on the registry',
  [['Fill', 'Fill a unit', 'A unit is a run of consecutive messages from one boot of the device: five here. Each of the three assigned nodes collects them, and fetches any it missed from the stores.'],
    ['Sign', 'Each computes and signs on its own', "Every node works out the unit's result by itself (for a store job, the Merkle root of those messages), signs it with its operator key and publishes a retained work message at the device's node. What it signed is on disk first, so a restart never signs another result."],
    ['Collect', "Collect each other's signatures", 'All three subscribe to the work on this device, so each sees the other two and counts how many signed the same result.'],
    ['Submit', 'One node submits', 'Once a quorum agrees they wait a few seconds for more signatures. The signer with the lowest address submits; if it does not, the others do after a delay. Many units go in one transaction.'],
    ['Settle', 'The contract settles', "It recovers each signer, checks they are active nodes of the job's role and enough of them, records the result, takes one unit's pay from the job's budget, splits it between the signers and names them in an event."],
    ['Audit', 'Audited, then mature', 'A verifier reads the names and checks them against the assignment plan. If all is well the rewards mature an epoch later and the nodes withdraw them. If not, the slash comes first.']],
  [['dev', 'signed results'], ['link', 'collecting and submitting'], ['chain', 'the contract']]),

  depin: () => scene('depin', 340, (A) =>
    T(90, 20, 'DEVICES', 'tm') + T(330, 20, 'ORACLES · COMPUTE NODES', 'tm') + T(575, 20, 'CONTRACTS', 'tm') +
    B(40, 50, 100, 44, 'x', 'Station 1') + B(40, 130, 100, 44, 'x', 'Station 2') + B(40, 210, 100, 44, 'x', 'Station 3') +
    B(270, 50, 120, 44, 'd', 'Oracle · US') + B(270, 130, 120, 44, 'd', 'Oracle · EU') + B(270, 210, 120, 44, 'd', 'Oracle · Asia') +
    B(510, 50, 130, 60, 'c', 'BoatRegistry', 'settles the epoch') + B(510, 160, 130, 70, 'c', 'DepinNetwork', 'rewards root, mint') + B(40, 286, 110, 36, 'x', 'Payee') +
    G(0, 5, [50, 130, 210].map((y) => `<circle class="f-chain" cx="140" cy="${y}" r="6"/>`).join('')) +
    G(1, 1, F('M146 72L270 72', 'dev') + F('M146 152L270 152', 'dev') + F('M146 232L270 232', 'dev') + F('M146 80L270 140', 'dev') + F('M146 224L270 164', 'dev')) +
    G(2, 2, F('M146 72L270 72', 'link', 1) + F('M146 80L270 80', 'link') + F('M146 152L270 152', 'link', 1) + F('M146 160L270 160', 'link') + F('M146 232L270 232', 'link', 1) + F('M146 240L270 240', 'link') + F('M146 218L270 90', 'link', 1)) +
    G(3, 3, F('M320 94L320 130', 'dev') + F('M340 94L340 130', 'dev', 1) + F('M320 174L320 210', 'dev') + F('M340 174L340 210', 'dev', 1)) +
    G(3, 5, R(36, 206, 108, 52, 'bad') + T(154, 232, 'ruled out', 'ts', 'start')) +
    G(4, 4, F('M390 72L510 76', 'link') + F('M390 146L510 88', 'link') + F('M390 222L510 100', 'link')) +
    G(4, 5, R(506, 46, 138, 68, 'chain')) +
    G(5, 5, F('M575 114L575 160', 'chain') + R(506, 156, 138, 78, 'chain') + F('M575 234L575 304L150 304', 'chain')),
  'Six steps of one epoch of a DePIN network',
  [['Enroll', 'Devices enroll', 'Anyone pays the fee to enroll a device on DepinNetwork (the blue dots). The device then signs a join record of its own: the map cell it says it is in, and who is paid for it. Station 3 names a place it is not in.'],
    ['Readings', 'Readings come in', 'Each device publishes signed, timestamped readings, slot after slot. Every oracle follows every device and keeps what it got.'],
    ['Ping', 'Oracles time a round trip', 'Once a minute each oracle pings each device and the device signs a pong. The shortest round trip of the epoch bounds how far the device can be from that oracle.'],
    ['Score', 'Sheets are compared and scored', "After the epoch every oracle publishes its evidence sheets and a signed index, and reads the others'. A message counts only when most sheets hold it. Devices are scored on uptime, reading quality and coverage. Station 3's place does not fit its round trips: ruled out, nothing earned."],
    ['Settle', 'The root is signed and settled', 'Each oracle builds the Merkle tree of rewards and signs its root. Once a quorum signed the same one, the epoch settles on the registry as a unit of the job, and the oracles are paid from its budget.'],
    ['Claim', 'Published, then claimed', "Anyone calls publishEpoch. DepinNetwork checks that the registry settled exactly this root and that the total is within the curve's emission, then mints. Rewards are claimed with a Merkle proof and go to the payee the device named."]],
  [['dev', 'messages and sheets'], ['link', 'pings and submissions'], ['chain', 'contracts'], ['bad', 'ruled out']]),

  slash: () => scene('slash', 300, (A) =>
    B(40, 110, 120, 70, 'd', 'A node', 'wrong result signed') + T(40, 204, 'STAKE', 'tm', 'start') +
    '<rect class="barframe dev" x="40" y="216" width="120" height="10" rx="5"/><rect class="xbar f-dev" x="40" y="216" width="120" height="10" rx="5" data-wat="5" data-w0="120" data-w1="96"/>' +
    B(270, 30, 120, 44, 'd', 'Watcher V1') + B(270, 130, 120, 44, 'd', 'Verifier V2') + B(270, 230, 120, 44, 'd', 'Verifier V3') +
    B(510, 110, 130, 84, 'c', 'BoatRegistry', 'stake-weighted vote') +
    G(0, 0, F('M160 130L270 60', 'dev')) +
    G(1, 5, R(36, 106, 128, 78, 'bad')) +
    G(1, 4, R(266, 26, 128, 52, 'link')) +
    G(2, 2, F('M330 78L330 130', 'link') + F('M394 52L430 52L430 252L390 252', 'link')) +
    G(3, 4, R(266, 126, 128, 52, 'link') + R(266, 226, 128, 52, 'link') + [402, 420, 438].map((x) => `<rect class="f-link" x="${x}" y="98" width="14" height="16" rx="3"/>`).join('')) +
    G(4, 4, F('M394 152L510 152', 'link') + '<rect class="f-link" x="-17" y="-7" width="34" height="14" rx="3"><animateMotion dur="1.6s" repeatCount="indefinite" path="M400 152L500 152"/></rect>') +
    G(5, 5, R(506, 106, 138, 92, 'chain') + T(575, 218, 'half to the submitter') + T(575, 238, 'the rest to the treasury') + T(100, 246, 'a fifth of the minimum')),
  'Six steps of a slash: found, evidenced, judged again, submitted, executed',
  [['Fault', 'A wrong result is signed', 'A node signs a result for a unit and publishes its work message, which carries the detail: the inputs it says it used and what it got. Three verifiers watch each device. V1 is one of them.'],
    ['Found', 'A watcher finds it', "V1 checks the work against the device's own messages. The result does not follow from the detail, or the rule gives another value, or an input contradicts what the device signed, or a store cannot show what it signed for. It counts as a fault only once the work's signature is checked."],
    ['Evidence', 'The fault goes out with its evidence', 'V1 signs "slash this node this much, for this reason" and sends it, with the evidence, to every verifier. Most of them do not follow this device, so it travels over a channel between verifiers.'],
    ['Judge', 'The others judge again', "V2 and V3 do not take V1's word. They judge from the evidence alone, or for a store run a spot check of their own. Those who agree sign. Those who do not, do nothing. The small marks are the signatures so far."],
    ['Submit', 'One verifier submits', 'With enough signatures, the signer with the lowest address submits; the others follow after a delay if it has not. It asks the contract first whether the votes are enough.'],
    ['Slash', 'The contract slashes', "Votes are weighed by stake: at least two signers, more than two thirds of the vote, and only verifiers that have been one for an epoch. Then a fifth of the minimum stake goes, with the rewards that had not matured. Half of the operator's own loss goes to the submitter, the rest to the treasury. Below the minimum, the node is no longer active."]],
  [['dev', 'nodes'], ['link', 'evidence and signatures'], ['chain', 'the contract'], ['bad', 'the accused']])
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

// The on-chain part of a network of MQTT nodes anyone can run
// (packages/boat-mqtt-node). Only what needs one global answer lives here:
//
// - Nodes: who runs one, with what stake, in which roles (forward, store,
//   verify, compute), under which HyperDHT key. Stake is an ERC-20 (a
//   stablecoin), bonded until an unbonding period has passed.
// - Anchors: verifier nodes post the Merkle roots of the verdicts they signed.
// - Slashing. Devices and nodes sign with Ed25519, which this chain cannot
//   check, so a node's statements that can cost it its stake are also signed
//   with its operator key (EIP-191 over a hash):
//     * equivocation: two different statements for the same batch, or two
//       different results for the same unit of a job, checked here;
//     * anything else (a wrong verdict, a store that fails spot checks, a wrong
//       computation): judged off-chain by the verifiers, and slashed here when
//       a quorum of them signs the same judgement.
//   Half of a slash goes to whoever submits it, half to the treasury, with
//   the node's rewards that have not matured yet.
// - Jobs: anyone posts paid work on a device's messages (store, verify or
//   compute them), with a budget. Nodes in that role do it off-chain, unit by
//   unit (a window of the device's sequence numbers), and sign their result
//   for each unit; a unit is settled when `quorum` active nodes signed the
//   same result, and they share its pay.
// - Rewards: what a node earns in one epoch can be withdrawn after the next
//   one has ended. Until then a slash takes it.
// - Forwarding: a forward job pays the node a device's messages went
//   through, per unit, once a quorum of verifiers that got them through that
//   node signs the same unit with it (settleForward).
// - Delegation: anyone stakes on a node. Delegators share the node's rewards
//   (less its commission), which compound in the pool, and its slashes, in
//   proportion to stake. A node's own stake must still meet the minimum.
// - Devices pay for their own jobs: an owner funds a device's balance here,
//   and a job request the device signs (its BoAT MER key) spends it.
// - Governance: once the admin has renounced, issuers and the treasury are
//   changed only by a quorum of the active verifiers (govern).
// - Devices: a device is claimed by its owner with a credential from a
//   manufacturer (an issuer's EIP-191 signature over its DID and wallet) and
//   the device's own consent (its EIP-191 signature naming the owner, from
//   BoAT MER's secp256k1 key).
contract BoatRegistry {
    uint8 public constant FORWARD = 1;
    uint8 public constant STORE = 2;
    uint8 public constant VERIFY = 4;
    uint8 public constant COMPUTE = 8;

    struct Node {
        bytes32 dhtKey;
        uint8 roles;
        bool active;
        uint64 unbondAt;
        uint64 since; // registered at; a verifier counts towards a quorum one epoch later
        uint256 stake;
    }

    struct Device {
        address owner;
        address wallet;
        address issuer;
    }

    struct Job {
        address payer;
        uint8 role;
        uint16 quorum;    // nodes that must sign the same result for a unit
        uint64 closesAt;  // 0 while open; work settles until then
        uint64 postedAt;  // block of the JobPosted event, which holds the params
        bytes32 device;
        bytes32 spec;     // what to do: a rule's hash, or a kind of work
        uint256 pay;      // per settled unit, shared by its signers
        uint256 budget;
        uint32 perEpoch;  // units that may settle in one epoch (bounds what a few bad nodes can take)
        uint32 settledInEpoch;
        uint64 lastEpoch;
    }

    struct Pool {
        uint256 stake;    // delegated, rewards compounded, slashes taken
        uint256 shares;
        uint256 ubStake;  // leaving (undelegated, in its unbonding period): still slashed
        uint256 ubShares;
        uint16 commissionBps; // of the delegators' part of rewards, to the operator
        uint16 nextBps;   // a new commission, from nextAt (one unbonding period on)
        uint64 nextAt;
    }

    struct Pending {
        uint256 shares;   // of the pool's leaving part
        uint64 at;
    }

    struct Reward {
        uint64 epoch;     // of `current`
        uint256 current;  // earned in that epoch
        uint256 previous; // earned in the epoch before
        uint256 matured;  // can be withdrawn
    }

    IERC20 public immutable token;
    uint256 public immutable minStake;
    uint64 public immutable unbonding;
    uint16 public immutable quorumBps;
    uint64 public immutable epochLength;
    uint64 public immutable jobNotice;
    address public admin;
    uint256 public treasury;

    mapping(address => Node) public nodes;
    address[] public operators; // everyone who ever registered
    address[] public verifiers;
    mapping(address => uint256) private verifierIndex; // index + 1
    mapping(address => mapping(uint64 => bytes32)) public anchors; // node -> batch -> root
    mapping(bytes32 => bool) public slashUsed;
    mapping(address => bool) public issuers;
    mapping(bytes32 => Device) public devices; // DID key -> device
    Job[] public jobs;
    mapping(bytes32 => bytes32) public settled; // keccak(job, unit) -> result
    mapping(address => Reward) private rewardOf;
    mapping(address => Pool) public pools; // operator -> delegated stake
    mapping(address => mapping(address => uint256)) public delegatorShares; // operator -> delegator -> shares
    mapping(address => mapping(address => Pending)) public undelegating; // delegator -> operator -> amount
    mapping(bytes32 => uint256) public deviceBalance; // DID key -> funds for its jobs
    mapping(bytes32 => uint64) public deviceNonce;
    mapping(bytes32 => bool) public governUsed;

    event NodeRegistered(address indexed operator, bytes32 dhtKey, uint8 roles, uint256 stake);
    event Unbonding(address indexed operator, uint64 unbondAt);
    event Withdrawn(address indexed operator, uint256 amount);
    event Anchored(address indexed operator, uint64 indexed batch, bytes32 root, uint32 count);
    event Slashed(address indexed operator, uint256 amount, bytes32 reason, address reporter);
    event DeviceClaimed(bytes32 indexed did, address indexed owner, address wallet, address issuer);
    event JobPosted(uint256 indexed id, address indexed payer, bytes32 indexed device, uint8 role, bytes32 spec, uint256 pay, uint16 quorum, uint256 budget, bytes params);
    event JobFunded(uint256 indexed id, uint256 amount);
    event JobClosing(uint256 indexed id, uint64 closesAt);
    event JobClosed(uint256 indexed id, uint256 refund);
    event Settled(uint256 indexed id, uint64 indexed unit, bytes32 result, uint256 signers, uint256 pay);
    event RewardsWithdrawn(address indexed operator, uint256 amount);
    event Delegated(address indexed operator, address indexed delegator, uint256 amount, uint256 shares);
    event Undelegated(address indexed operator, address indexed delegator, uint256 amount, uint64 at);
    event DeviceFunded(bytes32 indexed did, uint256 amount);
    event Governed(uint8 kind, address target, uint256 value, uint64 nonce);

    constructor(IERC20 token_, uint256 minStake_, uint64 unbonding_, uint16 quorumBps_, uint64 epochLength_, uint64 jobNotice_) {
        require(epochLength_ > 0, "epoch");
        token = token_;
        minStake = minStake_;
        unbonding = unbonding_;
        quorumBps = quorumBps_;
        epochLength = epochLength_;
        jobNotice = jobNotice_;
        admin = msg.sender;
    }

    // ---- nodes --------------------------------------------------------------

    function register(bytes32 dhtKey, uint8 roles, uint256 amount) external {
        Node storage n = nodes[msg.sender];
        require(n.stake == 0 && n.unbondAt == 0, "already registered");
        require(roles != 0 && roles < 16, "roles");
        require(amount >= minStake, "stake below minimum");
        require(token.transferFrom(msg.sender, address(this), amount), "stake transfer");
        nodes[msg.sender] = Node(dhtKey, roles, true, 0, uint64(block.timestamp), amount);
        operators.push(msg.sender);
        if (roles & VERIFY != 0) _addVerifier(msg.sender);
        emit NodeRegistered(msg.sender, dhtKey, roles, amount);
    }

    function addStake(uint256 amount) external {
        Node storage n = nodes[msg.sender];
        require(n.active, "not active");
        require(token.transferFrom(msg.sender, address(this), amount), "stake transfer");
        n.stake += amount;
    }

    function startUnbonding() external {
        Node storage n = nodes[msg.sender];
        require(n.active, "not active");
        n.active = false;
        n.unbondAt = uint64(block.timestamp) + unbonding;
        _removeVerifier(msg.sender);
        emit Unbonding(msg.sender, n.unbondAt);
    }

    // slashing still applies while unbonding
    function withdraw() external {
        Node storage n = nodes[msg.sender];
        require(!n.active && n.unbondAt != 0 && block.timestamp >= n.unbondAt, "still bonded");
        uint256 amount = n.stake;
        delete nodes[msg.sender];
        require(token.transfer(msg.sender, amount), "transfer");
        emit Withdrawn(msg.sender, amount);
    }

    function verifierCount() external view returns (uint256) {
        return verifiers.length;
    }

    function operatorCount() external view returns (uint256) {
        return operators.length;
    }

    function isActive(address operator, uint8 role) external view returns (bool) {
        Node storage n = nodes[operator];
        return n.active && n.stake >= minStake && n.roles & role != 0;
    }

    // ---- anchors ------------------------------------------------------------

    function anchor(uint64 batch, bytes32 root, uint32 count) external {
        Node storage n = nodes[msg.sender];
        require(n.active && n.roles & VERIFY != 0, "not a verifier");
        require(anchors[msg.sender][batch] == bytes32(0), "batch anchored");
        anchors[msg.sender][batch] = root;
        emit Anchored(msg.sender, batch, root, count);
    }

    // what a verifier signs for each batch, off-chain as well as here
    function anchorStatement(address operator, uint64 batch, bytes32 root, uint32 count) public view returns (bytes32) {
        return keccak256(abi.encode("boat-anchor/1", address(this), block.chainid, operator, batch, root, count));
    }

    // ---- slashing -------------------------------------------------------------

    // two different statements signed for one batch
    function slashEquivocation(address operator, uint64 batch, bytes32 rootA, uint32 countA, bytes calldata sigA, bytes32 rootB, uint32 countB, bytes calldata sigB) external {
        require(rootA != rootB || countA != countB, "same statement");
        require(_recover(_eip191(anchorStatement(operator, batch, rootA, countA)), sigA) == operator, "sigA");
        require(_recover(_eip191(anchorStatement(operator, batch, rootB, countB)), sigB) == operator, "sigB");
        bytes32 reason = keccak256(abi.encode("equivocation", batch));
        require(!slashUsed[keccak256(abi.encode(operator, reason))], "already slashed");
        slashUsed[keccak256(abi.encode(operator, reason))] = true;
        _slash(operator, nodes[operator].stake / 2, reason);
    }

    // two different results signed for one unit of a job
    function slashDoubleWork(address operator, uint256 id, uint64 unit, bytes32 resultA, bytes calldata sigA, bytes32 resultB, bytes calldata sigB) external {
        require(resultA != resultB, "same result");
        require(_recover(_eip191(workStatement(id, unit, resultA)), sigA) == operator, "sigA");
        require(_recover(_eip191(workStatement(id, unit, resultB)), sigB) == operator, "sigB");
        bytes32 reason = keccak256(abi.encode("double work", id, unit));
        require(!slashUsed[keccak256(abi.encode(operator, reason))], "already slashed");
        slashUsed[keccak256(abi.encode(operator, reason))] = true;
        _slash(operator, nodes[operator].stake / 2, reason);
    }

    function slashStatement(address operator, uint256 amount, bytes32 reason, uint64 nonce) public view returns (bytes32) {
        return keccak256(abi.encode("boat-slash/1", address(this), block.chainid, operator, amount, reason, nonce));
    }

    // a judgement signed by a quorum of active verifiers (not the operator itself)
    function slash(address operator, uint256 amount, bytes32 reason, uint64 nonce, bytes[] calldata sigs) external {
        bytes32 h = slashStatement(operator, amount, reason, nonce);
        require(!slashUsed[h], "already slashed");
        slashUsed[h] = true;
        _quorum(_eip191(h), sigs, operator);
        _slash(operator, amount, reason);
    }

    // an active verifier that has been one for an epoch: it votes
    function _votes(address v) internal view returns (bool) {
        Node storage n = nodes[v];
        return verifierIndex[v] != 0 && n.active && block.timestamp >= n.since + epochLength;
    }

    // a quorum of the voting verifiers other than `exclude`, weighted by
    // their stake (own and delegated): quorumBps of it, and two at least;
    // signatures sorted by signer
    function _quorum(bytes32 digest, bytes[] calldata sigs, address exclude) internal view {
        address last = address(0);
        uint256 signers = 0;
        uint256 weight = 0;
        for (uint256 i = 0; i < sigs.length; i++) {
            address s = _recover(digest, sigs[i]);
            require(s > last, "signers must be distinct and sorted");
            last = s;
            if (s != exclude && _votes(s)) {
                signers++;
                weight += totalStake(s);
            }
        }
        uint256 eligible = 0;
        for (uint256 i = 0; i < verifiers.length; i++) {
            address v = verifiers[i];
            if (v != exclude && _votes(v)) eligible += totalStake(v);
        }
        require(signers >= 2 && weight * 10000 >= eligible * quorumBps, "no quorum");
    }

    function _slash(address operator, uint256 amount, bytes32 reason) internal {
        Node storage n = nodes[operator];
        Pool storage p = pools[operator];
        // delegators share a slash in proportion, the leaving ones too, but
        // not once the operator has withdrawn (its record is gone)
        bool pooled = n.dhtKey != bytes32(0);
        uint256 total = n.stake + (pooled ? p.stake + p.ubStake : 0);
        if (amount > total) amount = total;
        uint256 fromPool = pooled && total > 0 ? (amount * p.stake) / total : 0;
        uint256 fromLeaving = pooled && total > 0 ? (amount * p.ubStake) / total : 0;
        p.stake -= fromPool;
        p.ubStake -= fromLeaving;
        uint256 own = amount - fromPool - fromLeaving;
        n.stake -= own;
        // rewards not matured yet go with it
        Reward storage r = rewardOf[operator];
        _roll(r);
        uint256 forfeited = r.current + r.previous;
        r.current = 0;
        r.previous = 0;
        amount += forfeited;
        require(amount > 0, "nothing to slash");
        // the reporter gets half of what the operator itself loses; what the
        // delegators lose goes to the treasury (no reward for reporting oneself
        // at their expense)
        uint256 reward = (own + forfeited) / 2;
        treasury += amount - reward;
        if (n.active && n.stake < minStake) {
            n.active = false;
            n.unbondAt = uint64(block.timestamp) + unbonding;
            _removeVerifier(operator);
        }
        require(token.transfer(msg.sender, reward), "reward");
        emit Slashed(operator, amount, reason, msg.sender);
    }

    // ---- jobs -------------------------------------------------------------------

    // params (emitted only) say how: for a compute job, the rule's WASM and
    // which readings it takes; spec binds them (keccak256 of the WASM, say).
    function postJob(bytes32 device, JobTerms calldata t, bytes calldata params) external returns (uint256 id) {
        require(token.transferFrom(msg.sender, address(this), t.budget), "budget transfer");
        id = _postJob(msg.sender, device, t, params);
    }

    function _postJob(address payer, bytes32 device, JobTerms calldata t, bytes calldata params) internal returns (uint256 id) {
        require(t.role == FORWARD || t.role == STORE || t.role == VERIFY || t.role == COMPUTE, "role");
        require(t.quorum >= 1 && t.pay > 0 && t.perEpoch > 0, "terms");
        id = jobs.length;
        jobs.push(Job(payer, t.role, t.quorum, 0, uint64(block.number), device, t.spec, t.pay, t.budget, t.perEpoch, 0, 0));
        emit JobPosted(id, payer, device, t.role, t.spec, t.pay, t.quorum, t.budget, params);
    }

    // a unit of the job settles now: within its budget and its rate
    function _spend(Job storage j) internal {
        require(j.budget >= j.pay, "budget spent");
        uint64 e = epoch();
        if (j.lastEpoch != e) {
            j.lastEpoch = e;
            j.settledInEpoch = 0;
        }
        require(j.settledInEpoch < j.perEpoch, "rate");
        j.settledInEpoch++;
        j.budget -= j.pay;
    }

    // ---- devices pay for their own jobs ----------------------------------------

    function fundDevice(bytes32 did, uint256 amount) external {
        require(devices[did].wallet != address(0), "unknown device");
        require(token.transferFrom(msg.sender, address(this), amount), "transfer");
        deviceBalance[did] += amount;
        emit DeviceFunded(did, amount);
    }

    // the owner takes back what the device has not spent
    function withdrawDevice(bytes32 did, uint256 amount) external {
        require(msg.sender == devices[did].owner, "owner");
        deviceBalance[did] -= amount;
        require(token.transfer(msg.sender, amount), "transfer");
    }

    struct JobTerms {
        uint8 role;
        uint16 quorum;
        uint32 perEpoch;  // units that may settle in one epoch
        uint64 deadline;  // a device's request: not after this time (postJob ignores it)
        bytes32 spec;
        uint256 pay;
        uint256 budget;
    }

    // what a device signs to post a job paid from its balance (EIP-191 over this hash)
    function jobRequestStatement(bytes32 did, JobTerms calldata t, bytes32 paramsHash, uint64 nonce) public view returns (bytes32) {
        return keccak256(abi.encode("boat-job/1", address(this), block.chainid, did, t, paramsHash, nonce));
    }

    // anyone relays the device's request; the job is about the device itself,
    // and its owner may close it
    function postJobFromDevice(bytes32 did, JobTerms calldata t, bytes calldata params, bytes calldata sig) external returns (uint256 id) {
        Device storage d = devices[did];
        require(d.wallet != address(0), "unknown device");
        require(block.timestamp <= t.deadline, "request expired");
        uint64 nonce = deviceNonce[did];
        require(_recover(_eip191(jobRequestStatement(did, t, keccak256(params), nonce)), sig) == d.wallet, "not signed by the device");
        require(deviceBalance[did] >= t.budget, "device balance");
        deviceNonce[did] = nonce + 1;
        deviceBalance[did] -= t.budget;
        id = _postJob(d.owner, did, t, params);
    }

    function jobCount() external view returns (uint256) {
        return jobs.length;
    }

    function fundJob(uint256 id, uint256 amount) external {
        Job storage j = jobs[id];
        require(j.closesAt == 0, "closing");
        require(token.transferFrom(msg.sender, address(this), amount), "budget transfer");
        j.budget += amount;
        emit JobFunded(id, amount);
    }

    // first call: the job closes after jobNotice, so work under way still
    // settles; a call after that returns what is left of the budget
    function closeJob(uint256 id) external {
        Job storage j = jobs[id];
        require(msg.sender == j.payer, "payer");
        if (j.closesAt == 0) {
            j.closesAt = uint64(block.timestamp) + jobNotice;
            emit JobClosing(id, j.closesAt);
            return;
        }
        require(block.timestamp >= j.closesAt, "notice");
        uint256 refund = j.budget;
        j.budget = 0;
        require(token.transfer(j.payer, refund), "transfer");
        emit JobClosed(id, refund);
    }

    // what a node signs for a unit of a job (EIP-191 over this hash)
    function workStatement(uint256 id, uint64 unit, bytes32 result) public view returns (bytes32) {
        return keccak256(abi.encode("boat-work/1", address(this), block.chainid, id, unit, result));
    }

    // a unit is settled once: the active nodes of the job's role that signed
    // the result (sorted by address, at least `quorum`) share its pay
    function settle(uint256 id, uint64 unit, bytes32 result, bytes[] calldata sigs) external {
        Job storage j = jobs[id];
        require(j.role != FORWARD, "forward jobs settle with settleForward");
        require(j.closesAt == 0 || block.timestamp < j.closesAt, "job closed");
        require(result != bytes32(0), "result");
        bytes32 k = keccak256(abi.encode(id, unit));
        require(settled[k] == bytes32(0), "settled");
        bytes32 digest = _eip191(workStatement(id, unit, result));
        address[] memory paid = new address[](sigs.length);
        uint256 n = 0;
        address last = address(0);
        for (uint256 i = 0; i < sigs.length; i++) {
            address s = _recover(digest, sigs[i]);
            require(s > last, "signers must be distinct and sorted");
            last = s;
            Node storage node = nodes[s];
            if (node.active && node.stake >= minStake && node.roles & j.role != 0) paid[n++] = s;
        }
        require(n >= j.quorum, "no quorum");
        settled[k] = result;
        _spend(j);
        uint256 share = j.pay / n;
        for (uint256 i = 0; i < n; i++) _credit(paid[i], share);
        treasury += j.pay - share * n;
        emit Settled(id, unit, result, n, j.pay);
    }

    // a forward job's unit: the node the messages went through signs
    // keccak(forwarder, root of the messages) with at least `quorum` active
    // verifiers that got them through it; the forwarder is paid
    function settleForward(uint256 id, uint64 unit, bytes32 root, address forwarder, bytes[] calldata sigs) external {
        Job storage j = jobs[id];
        require(j.role == FORWARD, "role");
        require(j.closesAt == 0 || block.timestamp < j.closesAt, "job closed");
        require(root != bytes32(0), "result");
        bytes32 k = keccak256(abi.encode(id, unit));
        require(settled[k] == bytes32(0), "settled");
        Node storage f = nodes[forwarder];
        require(f.active && f.stake >= minStake && f.roles & FORWARD != 0, "forwarder");
        bytes32 result = keccak256(abi.encode(forwarder, root));
        bytes32 digest = _eip191(workStatement(id, unit, result));
        bool signed = false;
        uint256 n = 0;
        address last = address(0);
        for (uint256 i = 0; i < sigs.length; i++) {
            address s = _recover(digest, sigs[i]);
            require(s > last, "signers must be distinct and sorted");
            last = s;
            if (s == forwarder) signed = true;
            else if (_votes(s)) n++;
        }
        require(signed, "not signed by the forwarder");
        require(n >= j.quorum, "no quorum");
        settled[k] = result;
        _spend(j);
        _credit(forwarder, j.pay);
        emit Settled(id, unit, result, n + 1, j.pay);
    }

    struct SettleItem {
        uint256 id;
        uint64 unit;
        bytes32 result;
        bytes[] sigs;
    }

    struct ForwardItem {
        uint256 id;
        uint64 unit;
        bytes32 root;
        address forwarder;
        bytes[] sigs;
    }

    // many units in one transaction; one that cannot settle (settled already,
    // no quorum, over its rate) is skipped, not the batch. Returns how many settled.
    function settleMany(SettleItem[] calldata items) external returns (uint256 n) {
        for (uint256 i = 0; i < items.length; i++) {
            try this.settle(items[i].id, items[i].unit, items[i].result, items[i].sigs) { n++; } catch {}
        }
    }

    function settleForwardMany(ForwardItem[] calldata items) external returns (uint256 n) {
        for (uint256 i = 0; i < items.length; i++) {
            try this.settleForward(items[i].id, items[i].unit, items[i].root, items[i].forwarder, items[i].sigs) { n++; } catch {}
        }
    }

    // ---- rewards ------------------------------------------------------------------

    function epoch() public view returns (uint64) {
        return uint64(block.timestamp / epochLength);
    }

    // (not matured yet, can be withdrawn)
    function rewards(address operator) external view returns (uint256 pending, uint256 matured) {
        Reward memory r = rewardOf[operator];
        uint64 e = epoch();
        if (e == r.epoch) return (r.current + r.previous, r.matured);
        if (e == r.epoch + 1) return (r.current, r.matured + r.previous);
        return (0, r.matured + r.previous + r.current);
    }

    function withdrawRewards() external {
        Reward storage r = rewardOf[msg.sender];
        _roll(r);
        uint256 amount = r.matured;
        require(amount > 0, "nothing matured");
        r.matured = 0;
        require(token.transfer(msg.sender, amount), "transfer");
        emit RewardsWithdrawn(msg.sender, amount);
    }

    // the delegators' part (by stake, less commission) compounds in the pool
    function _credit(address operator, uint256 amount) internal {
        Pool storage p = pools[operator];
        if (p.nextAt != 0 && block.timestamp >= p.nextAt) {
            p.commissionBps = p.nextBps;
            p.nextAt = 0;
        }
        if (p.stake > 0) {
            uint256 theirs = (amount * p.stake) / (nodes[operator].stake + p.stake);
            theirs -= (theirs * p.commissionBps) / 10000;
            p.stake += theirs;
            amount -= theirs;
        }
        Reward storage r = rewardOf[operator];
        _roll(r);
        r.current += amount;
    }

    // ---- delegation ------------------------------------------------------------------

    function totalStake(address operator) public view returns (uint256) {
        return nodes[operator].stake + pools[operator].stake;
    }

    // takes effect one unbonding period from now, so delegators can leave first
    function setCommission(uint16 bps) external {
        require(nodes[msg.sender].stake > 0, "not a node");
        require(bps <= 5000, "commission");
        Pool storage p = pools[msg.sender];
        if (p.nextAt != 0 && block.timestamp >= p.nextAt) p.commissionBps = p.nextBps;
        p.nextBps = bps;
        p.nextAt = uint64(block.timestamp) + unbonding;
    }

    function delegate(address operator, uint256 amount) external {
        require(nodes[operator].active, "not active");
        Pool storage p = pools[operator];
        require(p.stake > 0 || p.shares == 0, "pool slashed to nothing");
        require(token.transferFrom(msg.sender, address(this), amount), "transfer");
        uint256 shares = p.shares == 0 ? amount : (amount * p.shares) / p.stake;
        require(shares > 0, "too little");
        p.stake += amount;
        p.shares += shares;
        delegatorShares[operator][msg.sender] += shares;
        emit Delegated(operator, msg.sender, amount, shares);
    }

    // the stake leaves the pool now; it is still slashed, with the pool,
    // until it comes back after the unbonding period
    function undelegate(address operator, uint256 shares) external {
        Pool storage p = pools[operator];
        delegatorShares[operator][msg.sender] -= shares;
        uint256 amount = (shares * p.stake) / p.shares;
        p.shares -= shares;
        p.stake -= amount;
        require(p.ubStake > 0 || p.ubShares == 0, "leaving part slashed to nothing");
        uint256 ub = p.ubShares == 0 ? amount : (amount * p.ubShares) / p.ubStake;
        p.ubStake += amount;
        p.ubShares += ub;
        Pending storage u = undelegating[msg.sender][operator];
        u.shares += ub;
        u.at = uint64(block.timestamp) + unbonding;
        emit Undelegated(operator, msg.sender, amount, u.at);
    }

    function withdrawUndelegated(address operator) external {
        Pending storage u = undelegating[msg.sender][operator];
        require(u.shares > 0 && block.timestamp >= u.at, "still bonded");
        Pool storage p = pools[operator];
        uint256 amount = (u.shares * p.ubStake) / p.ubShares;
        p.ubShares -= u.shares;
        p.ubStake -= amount;
        u.shares = 0;
        require(token.transfer(msg.sender, amount), "transfer");
    }

    // ---- governance --------------------------------------------------------------------

    uint8 public constant GOV_ISSUER = 1;   // target: issuer, value: 1 allowed, 0 not
    uint8 public constant GOV_TREASURY = 2; // target: to, value: amount

    function renounceAdmin() external {
        require(msg.sender == admin, "admin");
        admin = address(0);
    }

    function governStatement(uint8 kind, address target, uint256 value, uint64 nonce) public view returns (bytes32) {
        return keccak256(abi.encode("boat-govern/1", address(this), block.chainid, kind, target, value, nonce));
    }

    // a change signed by a quorum of the active verifiers
    function govern(uint8 kind, address target, uint256 value, uint64 nonce, bytes[] calldata sigs) external {
        bytes32 h = governStatement(kind, target, value, nonce);
        require(!governUsed[h], "used");
        governUsed[h] = true;
        _quorum(_eip191(h), sigs, address(0));
        if (kind == GOV_ISSUER) {
            issuers[target] = value != 0;
        } else if (kind == GOV_TREASURY) {
            treasury -= value;
            require(token.transfer(target, value), "transfer");
        } else {
            revert("kind");
        }
        emit Governed(kind, target, value, nonce);
    }

    function _roll(Reward storage r) internal {
        uint64 e = epoch();
        if (e == r.epoch) return;
        if (e == r.epoch + 1) {
            r.matured += r.previous;
            r.previous = r.current;
        } else {
            r.matured += r.previous + r.current;
            r.previous = 0;
        }
        r.current = 0;
        r.epoch = e;
    }

    // ---- devices --------------------------------------------------------------

    // the admin, until it renounces; then govern()
    function setIssuer(address issuer, bool allowed) external {
        require(msg.sender == admin && admin != address(0), "admin");
        issuers[issuer] = allowed;
    }

    // the texts that are signed (EIP-191 personal_sign)
    function credentialText(bytes32 did, address wallet) public pure returns (string memory) {
        return string.concat("boat-cred:", _hex(abi.encodePacked(did)), ":", _hex(abi.encodePacked(wallet)));
    }

    function claimText(bytes32 did, address owner) public view returns (string memory) {
        return string.concat("boat-claim:", _dec(block.chainid), ":", _hex(abi.encodePacked(address(this))), ":", _hex(abi.encodePacked(did)), ":", _hex(abi.encodePacked(owner)));
    }

    function claimDevice(bytes32 did, address wallet, bytes calldata credential, bytes calldata consent) external {
        require(devices[did].owner == address(0), "already claimed");
        address issuer = _recover(_eip191Text(credentialText(did, wallet)), credential);
        require(issuers[issuer], "unknown issuer");
        require(_recover(_eip191Text(claimText(did, msg.sender)), consent) == wallet, "device did not consent");
        devices[did] = Device(msg.sender, wallet, issuer);
        emit DeviceClaimed(did, msg.sender, wallet, issuer);
    }

    // ---- helpers ----------------------------------------------------------------

    function _addVerifier(address v) internal {
        if (verifierIndex[v] != 0) return;
        verifiers.push(v);
        verifierIndex[v] = verifiers.length;
    }

    function _removeVerifier(address v) internal {
        uint256 i = verifierIndex[v];
        if (i == 0) return;
        address last = verifiers[verifiers.length - 1];
        verifiers[i - 1] = last;
        verifierIndex[last] = i;
        verifiers.pop();
        delete verifierIndex[v];
    }

    function _eip191(bytes32 h) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h));
    }

    function _eip191Text(string memory text) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n", _dec(bytes(text).length), text));
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        require(sig.length == 65, "signature length");
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        require(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "high s");
        address a = ecrecover(digest, v, r, s);
        require(a != address(0), "bad signature");
        return a;
    }

    function _hex(bytes memory b) internal pure returns (string memory) {
        bytes memory out = new bytes(2 + b.length * 2);
        out[0] = "0";
        out[1] = "x";
        bytes16 digits = "0123456789abcdef";
        for (uint256 i = 0; i < b.length; i++) {
            out[2 + 2 * i] = digits[uint8(b[i]) >> 4];
            out[3 + 2 * i] = digits[uint8(b[i]) & 15];
        }
        return string(out);
    }

    function _dec(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) len++;
        bytes memory out = new bytes(len);
        for (; v != 0; v /= 10) out[--len] = bytes1(uint8(48 + v % 10));
        return string(out);
    }
}

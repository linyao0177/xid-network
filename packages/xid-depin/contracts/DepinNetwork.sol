// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20Like {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

interface IMintable {
    function mint(address to, uint256 value) external;
}

// what this contract reads from BoatRegistry (packages/boat-registry)
interface IBoatRegistry {
    function token() external view returns (address);
    function settled(bytes32 key) external view returns (bytes32);
    function jobs(uint256 id) external view returns (
        address payer, uint8 role, uint16 quorum, uint64 closesAt, uint64 postedAt, bytes32 device, bytes32 spec,
        uint256 pay, uint256 budget, uint32 perEpoch, uint32 settledInEpoch, uint64 lastEpoch, uint16 batchUnits);
    function fundJob(uint256 id, uint256 amount) external;
}

// A DePIN network on the xid network: devices that sense or serve somewhere
// (weather stations, air-quality sensors, energy meters) and are rewarded
// each epoch for what they did, by a curve this contract fixes.
//
// - Devices enroll here (anyone enrolls one, for the network's fee). Where a
//   device is and who is paid for it are not here: the device signs them
//   itself (its Ed25519 key, which this chain cannot check), in a join record
//   it publishes, and the oracles read it.
// - Oracles are the compute nodes of the registry assigned to this network's
//   job: a compute job on the registry whose device is the network's key and
//   whose spec is DEPIN_SPEC. Its units are this network's epochs. For each
//   epoch the oracles score every device from its signed readings, location
//   and coverage evidence (packages/xid-depin, lib/score.js) and sign
//   keccak(statement) as the unit's result. A quorum of them settles it on
//   the registry, which pays them from the job's budget.
// - Anyone then publishes the epoch here with the Merkle root of its rewards:
//   this contract checks that the registry settled exactly that statement,
//   and that the total is within the curve's emission for the epoch.
// - Rewards are claimed with a Merkle proof and paid to the payee the device
//   named. The token is minted at publication (mintable) or comes from what
//   this contract holds.
contract DepinNetwork {
    bytes32 public constant DEPIN_SPEC = keccak256("xid-depin/1");
    uint8 public constant COMPUTE = 8;

    uint8 public constant CONSTANT = 0;    // initial every epoch
    uint8 public constant HALVING = 1;     // initial >> (epoch / period)
    uint8 public constant EXPONENTIAL = 2; // initial * (1 - rate/1e18)^epoch
    uint8 public constant LINEAR = 3;      // initial - rate * epoch, down to 0
    uint8 public constant STEPS = 4;       // amounts[i] while epoch < untils[i]

    struct Curve {
        uint8 kind;
        uint256 initial;
        uint64 period;   // HALVING
        uint256 rate;    // EXPONENTIAL: decay per epoch, 1e18 = 100%; LINEAR: decrease per epoch
        uint256 floor;   // never less than this (tail emission), until `end`
        uint64 end;      // no emission from this epoch on (0: never ends)
        uint64[] untils; // STEPS
        uint256[] amounts;
    }

    struct Epoch {
        bytes32 root;
        uint256 total;
        uint32 devices;
        uint64 publishedAt;
    }

    IBoatRegistry public immutable registry;
    bytes32 public immutable networkKey; // the network's HyperDHT key: the job's device
    bytes32 public immutable configHash; // keccak of the network's config (templates/*.json)
    address public immutable rewardToken;
    bool public immutable mintable;
    uint64 public immutable start;       // epoch 0 begins
    uint64 public immutable epochLength;
    uint256 public immutable enrollFee;  // in the registry's token; funds the oracles' job
    uint32 public immutable maxDevices;

    Curve internal curve;
    address public admin;
    mapping(uint256 => bool) public jobAttached;
    uint256 public currentJob;
    bool public hasJob;

    bytes32[] public devices;
    mapping(bytes32 => uint64) public enrolledAt; // 0: not enrolled
    mapping(bytes32 => uint64) public removedAt;

    mapping(uint64 => Epoch) public epochs;
    mapping(bytes32 => bool) public claimed; // keccak(epoch, did)
    uint256 public emitted;
    uint256 public owed;  // published, not claimed (not mintable: held here)
    uint256 public fees;  // enrollment fees not yet sent to the job

    event Enrolled(bytes32 indexed did, address indexed by);
    event Removed(bytes32 indexed did);
    event JobAttached(uint256 indexed id);
    event EpochPublished(uint64 indexed epoch, bytes32 root, uint256 total, uint32 devices);
    event Claimed(uint64 indexed epoch, bytes32 indexed did, address payee, uint256 amount);
    event FeesSent(uint256 indexed job, uint256 amount);

    constructor(
        IBoatRegistry registry_, bytes32 networkKey_, bytes32 configHash_, address rewardToken_, bool mintable_,
        uint64 start_, uint64 epochLength_, uint256 enrollFee_, uint32 maxDevices_, Curve memory curve_
    ) {
        require(epochLength_ > 0, "epoch length");
        require(curve_.kind <= STEPS, "curve");
        require(curve_.kind != HALVING || curve_.period > 0, "period");
        require(curve_.kind != EXPONENTIAL || curve_.rate < 1e18, "rate");
        require(curve_.untils.length == curve_.amounts.length, "steps");
        for (uint256 i = 1; i < curve_.untils.length; i++) require(curve_.untils[i] > curve_.untils[i - 1], "steps order");
        registry = registry_;
        networkKey = networkKey_;
        configHash = configHash_;
        rewardToken = rewardToken_;
        mintable = mintable_;
        start = start_;
        epochLength = epochLength_;
        enrollFee = enrollFee_;
        maxDevices = maxDevices_;
        curve = curve_;
        admin = msg.sender;
    }

    // ---- the curve ----------------------------------------------------------------

    function curveOf() external view returns (Curve memory) {
        return curve;
    }

    // (1e18 fixed point) x^n, rounding down at every step; lib/curve.js does the same
    function rpow(uint256 x, uint64 n) public pure returns (uint256 z) {
        z = 1e18;
        while (n > 0) {
            if (n & 1 == 1) z = (z * x) / 1e18;
            x = (x * x) / 1e18;
            n >>= 1;
        }
    }

    // the most that epoch e may pay out
    function emission(uint64 e) public view returns (uint256 v) {
        Curve storage c = curve;
        if (c.end != 0 && e >= c.end) return 0;
        if (c.kind == CONSTANT) {
            v = c.initial;
        } else if (c.kind == HALVING) {
            uint64 k = e / c.period;
            v = k >= 256 ? 0 : c.initial >> k;
        } else if (c.kind == EXPONENTIAL) {
            v = (c.initial * rpow(1e18 - c.rate, e)) / 1e18;
        } else if (c.kind == LINEAR) {
            uint256 d = c.rate * e;
            v = c.initial > d ? c.initial - d : 0;
        } else {
            for (uint256 i = 0; i < c.untils.length; i++) {
                if (e < c.untils[i]) {
                    v = c.amounts[i];
                    break;
                }
            }
        }
        if (v < c.floor) v = c.floor;
    }

    function epoch() public view returns (uint64) {
        if (block.timestamp < start) return 0;
        return uint64((block.timestamp - start) / epochLength);
    }

    function epochStart(uint64 e) public view returns (uint64) {
        return start + e * epochLength;
    }

    // ---- devices ------------------------------------------------------------------

    function deviceCount() external view returns (uint256) {
        return devices.length;
    }

    // a device takes part in epoch e if it was enrolled before e ended and not
    // removed before e began (lib/oracle.js reads devices[] the same way)
    function inEpoch(bytes32 did, uint64 e) public view returns (bool) {
        uint64 a = enrolledAt[did];
        uint64 r = removedAt[did];
        return a != 0 && a < epochStart(e + 1) && (r == 0 || r > epochStart(e));
    }

    function enroll(bytes32 did) external {
        require(did != bytes32(0) && did != networkKey, "did");
        require(enrolledAt[did] == 0, "enrolled");
        require(maxDevices == 0 || devices.length < maxDevices, "full");
        if (enrollFee > 0) {
            require(IERC20Like(registry.token()).transferFrom(msg.sender, address(this), enrollFee), "fee");
            fees += enrollFee;
        }
        enrolledAt[did] = uint64(block.timestamp);
        devices.push(did);
        emit Enrolled(did, msg.sender);
    }

    // a device that cheats or is gone; it is never enrolled again
    function remove(bytes32 did) external {
        require(msg.sender == admin, "admin");
        require(enrolledAt[did] != 0 && removedAt[did] == 0, "not enrolled");
        removedAt[did] = uint64(block.timestamp);
        emit Removed(did);
    }

    // ---- the oracles' job ------------------------------------------------------------

    // a compute job on the registry about this network: its key as the device,
    // DEPIN_SPEC as the spec. Several may be attached (a new one when the
    // last runs dry); any of them settles an epoch.
    function attachJob(uint256 id) external {
        require(msg.sender == admin, "admin");
        (, uint8 role,,,, bytes32 device, bytes32 spec,,,,,,) = registry.jobs(id);
        require(role == COMPUTE && device == networkKey && spec == DEPIN_SPEC, "not this network's job");
        jobAttached[id] = true;
        currentJob = id;
        hasJob = true;
        emit JobAttached(id);
    }

    // enrollment fees go to the current job's budget: devices pay for the
    // oracles that score them
    function sendFees() external {
        require(hasJob && fees > 0, "nothing to send");
        uint256 amount = fees;
        fees = 0;
        IERC20Like t = IERC20Like(registry.token());
        require(t.approve(address(registry), amount), "approve");
        registry.fundJob(currentJob, amount);
        emit FeesSent(currentJob, amount);
    }

    function renounceAdmin() external {
        require(msg.sender == admin, "admin");
        admin = address(0);
    }

    // ---- epochs -------------------------------------------------------------------

    // what the oracles sign as the result of unit `e` of the job
    function epochStatement(uint64 e, bytes32 root, uint256 total, uint32 count) public view returns (bytes32) {
        return keccak256(abi.encode("xid-depin/epoch/1", address(this), block.chainid, e, root, total, count));
    }

    function publishEpoch(uint256 job, uint64 e, bytes32 root, uint256 total, uint32 count) external {
        require(jobAttached[job], "job");
        require(e < epoch(), "epoch not over");
        require(epochs[e].publishedAt == 0, "published");
        require(root != bytes32(0), "root");
        require(registry.settled(keccak256(abi.encode(job, e))) == epochStatement(e, root, total, count), "not settled on the registry");
        require(total <= emission(e), "over the emission");
        epochs[e] = Epoch(root, total, count, uint64(block.timestamp));
        emitted += total;
        if (mintable) {
            IMintable(rewardToken).mint(address(this), total);
        } else {
            require(IERC20Like(rewardToken).balanceOf(address(this)) >= owed + total, "not funded");
        }
        owed += total;
        emit EpochPublished(e, root, total, count);
    }

    // ---- claims -------------------------------------------------------------------

    function leaf(uint64 e, bytes32 did, address payee, uint256 amount) public pure returns (bytes32) {
        return keccak256(abi.encode(e, did, payee, amount));
    }

    // anyone may send it: the reward goes to the payee the device named
    function claim(uint64 e, bytes32 did, address payee, uint256 amount, bytes32[] calldata proof) public {
        Epoch storage ep = epochs[e];
        require(ep.publishedAt != 0, "not published");
        bytes32 k = keccak256(abi.encode(e, did));
        require(!claimed[k], "claimed");
        require(_verify(leaf(e, did, payee, amount), proof, ep.root), "proof");
        claimed[k] = true;
        owed -= amount;
        require(IERC20Like(rewardToken).transfer(payee, amount), "transfer");
        emit Claimed(e, did, payee, amount);
    }

    struct ClaimItem {
        uint64 epoch;
        bytes32 did;
        address payee;
        uint256 amount;
        bytes32[] proof;
    }

    // several claims; one that is claimed already is skipped
    function claimMany(ClaimItem[] calldata items) external returns (uint256 n) {
        for (uint256 i = 0; i < items.length; i++) {
            ClaimItem calldata c = items[i];
            if (claimed[keccak256(abi.encode(c.epoch, c.did))]) continue;
            claim(c.epoch, c.did, c.payee, c.amount, c.proof);
            n++;
        }
    }

    // sorted pairs, as boat-registry's lib/merkle.js
    function _verify(bytes32 h, bytes32[] calldata proof, bytes32 root) internal pure returns (bool) {
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            h = h < p ? keccak256(abi.encodePacked(h, p)) : keccak256(abi.encodePacked(p, h));
        }
        return h == root;
    }
}

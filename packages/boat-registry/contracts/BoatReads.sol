// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20R {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

interface IRegistryR {
    function isActive(address operator, uint8 role) external view returns (bool);
}

// Paid reads from storage nodes: a payment channel per reader and store.
//
// The reader deposits; with every request it signs how much it owes the
// store in all (EIP-191 over readStatement), and the store serves while that
// sum grows by its price. The store redeems the latest sum when it likes.
// The reader gets back what was never owed after it closes the channel and
// a notice has passed, in which the store can still redeem.
contract BoatReads {
    uint8 constant STORE = 2;

    struct Channel {
        uint256 deposit;
        uint256 redeemed;
        uint64 closesAt;
        uint64 generation; // a closed channel's vouchers are no good after it reopens
    }

    IERC20R public immutable token;
    IRegistryR public immutable registry;
    uint64 public immutable notice;
    mapping(address => mapping(address => Channel)) public channels; // reader -> store operator

    event Opened(address indexed reader, address indexed store, uint256 deposit);
    event Redeemed(address indexed reader, address indexed store, uint256 amount, uint256 cumulative);
    event Closing(address indexed reader, address indexed store, uint64 closesAt);
    event Closed(address indexed reader, address indexed store, uint256 refund);

    constructor(IERC20R token_, IRegistryR registry_, uint64 notice_) {
        require(notice_ > 0, "notice");
        token = token_;
        registry = registry_;
        notice = notice_;
    }

    function readStatement(address reader, address store, uint64 generation, uint256 cumulative) public view returns (bytes32) {
        return keccak256(abi.encode("boat-read/1", address(this), block.chainid, reader, store, generation, cumulative));
    }

    function open(address store, uint256 amount) external {
        require(registry.isActive(store, STORE), "not an active store");
        require(token.transferFrom(msg.sender, address(this), amount), "transfer");
        Channel storage c = channels[msg.sender][store];
        c.deposit += amount;
        c.closesAt = 0;
        emit Opened(msg.sender, store, c.deposit);
    }

    function redeem(address reader, uint256 cumulative, bytes calldata sig) external {
        Channel storage c = channels[reader][msg.sender];
        require(c.closesAt == 0 || block.timestamp < c.closesAt, "closed");
        require(cumulative > c.redeemed && cumulative <= c.deposit, "amount");
        require(_recover(keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", readStatement(reader, msg.sender, c.generation, cumulative))), sig) == reader, "not signed by the reader");
        uint256 amount = cumulative - c.redeemed;
        c.redeemed = cumulative;
        require(token.transfer(msg.sender, amount), "transfer");
        emit Redeemed(reader, msg.sender, amount, cumulative);
    }

    // first call starts the notice; a call after it returns what is left
    function close(address store) external {
        Channel storage c = channels[msg.sender][store];
        if (c.closesAt == 0) {
            c.closesAt = uint64(block.timestamp) + notice;
            emit Closing(msg.sender, store, c.closesAt);
            return;
        }
        require(block.timestamp >= c.closesAt, "notice");
        uint256 refund = c.deposit - c.redeemed;
        // a fresh channel next time: nothing owed, old vouchers void
        c.deposit = 0;
        c.redeemed = 0;
        c.closesAt = 0;
        c.generation++;
        require(token.transfer(msg.sender, refund), "transfer");
        emit Closed(msg.sender, store, refund);
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
}

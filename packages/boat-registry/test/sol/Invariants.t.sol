// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Invariant tests of BoatRegistry: forge test (forge-std in sol-lib/forge-std).
//
// A handler registers nodes, delegates and undelegates, settles units and
// batches, slashes (by a quorum, and for double work or a double batch, the
// node reporting itself too), sets capacities, closes jobs, withdraws, and
// moves time, in random order. After every step:
//   - the tokens the registry holds equal what it owes: stakes, pools (bonded
//     and leaving), job budgets, rewards, device balances and the treasury;
//   - a node's total stake is its own stake and its bonded pool;
//   - nobody gains by reporting itself;
//   - a batch settles at most once, a batch job never unit by unit, and no
//     job settles more units in an epoch than its rate.

import "forge-std/Test.sol";
import "../../contracts/BoatRegistry.sol";
import "../../contracts/TestToken.sol";

contract Handler is Test {
    BoatRegistry public reg;
    TestToken public token;
    uint256[] public keys;
    address[] public nodes;
    address[] public delegators;
    uint256[] public jobIds;
    uint256[] public batchJobIds;
    mapping(bytes32 => uint256) public batchSettles; // job:batch -> successful settleBatch calls
    uint256 public batchSettledTwice;
    uint256 public unitOnBatchJob;
    uint256 public selfReportGain; // what nodes got by reporting themselves, less what they lost
    mapping(bytes32 => uint256) public done; // successful calls, by kind
    uint64 nonce;

    uint256 constant MIN = 100e6;
    uint8 constant ALL = 15;

    constructor(BoatRegistry reg_, TestToken token_) {
        reg = reg_;
        token = token_;
        for (uint256 i = 0; i < 5; i++) {
            uint256 k = uint256(keccak256(abi.encode("node", i))) % (2 ** 200) + 1;
            address a = vm.addr(k);
            keys.push(k);
            nodes.push(a);
            token.mint(a, 10_000e6);
            vm.startPrank(a);
            token.approve(address(reg), type(uint256).max);
            reg.register(bytes32(uint256(i + 1)), ALL, 20 * MIN + i * 50e6); // room for a few slashes
            vm.stopPrank();
        }
        for (uint256 i = 0; i < 3; i++) {
            address d = address(uint160(0xD000 + i));
            delegators.push(d);
            token.mint(d, 10_000e6);
            vm.prank(d);
            token.approve(address(reg), type(uint256).max);
        }
        address payer = address(0xBEEF);
        token.mint(payer, 1_000_000e6);
        vm.startPrank(payer);
        token.approve(address(reg), type(uint256).max);
        for (uint8 r = 0; r < 4; r++) {
            uint8 role = uint8(1 << r);
            jobIds.push(reg.postJob(bytes32(uint256(0xDD)), BoatRegistry.JobTerms(role, 2, 50, 0, keccak256("spec"), 3e6, 3_000e6), ""));
        }
        for (uint8 r = 0; r < 4; r++) {
            uint8 role = uint8(1 << r);
            uint256 id = reg.postBatchJob(bytes32(uint256(0xDE)), BoatRegistry.JobTerms(role, 2, 50, 0, keccak256("spec"), 3e6, 3_000e6), 6, "");
            jobIds.push(id);
            batchJobIds.push(id);
        }
        vm.stopPrank();
        vm.warp(block.timestamp + reg.epochLength() + 1); // verifiers vote from now
    }

    function nodeCount() external view returns (uint256) { return nodes.length; }
    function delegatorCount() external view returns (uint256) { return delegators.length; }
    function jobCount() external view returns (uint256) { return jobIds.length; }
    function batchJobCount() external view returns (uint256) { return batchJobIds.length; }

    // BoatRegistry's statements (internal there)
    function _slashStatement(address op, uint256 amount, bytes32 reason, uint64 n) internal view returns (bytes32) {
        return keccak256(abi.encode("boat-slash/1", address(reg), block.chainid, op, amount, reason, n));
    }

    function _batchStatement(uint256 id, uint64 b, bytes32 root, uint32 n, address fwd) internal view returns (bytes32) {
        return keccak256(abi.encode("boat-batch/2", address(reg), block.chainid, id, b, root, n, fwd));
    }

    function _sig(uint256 k, bytes32 h) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(k, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h)));
        return abi.encodePacked(r, s, v);
    }

    // signatures of the nodes in `mask`, sorted by address
    function _sigs(uint8 mask, bytes32 h) internal view returns (bytes[] memory out) {
        uint256 n = 0;
        uint256[] memory idx = new uint256[](nodes.length);
        for (uint256 i = 0; i < nodes.length; i++) if (mask & (1 << i) != 0) idx[n++] = i;
        for (uint256 i = 0; i < n; i++) for (uint256 j = i + 1; j < n; j++) if (nodes[idx[j]] < nodes[idx[i]]) (idx[i], idx[j]) = (idx[j], idx[i]);
        out = new bytes[](n);
        for (uint256 i = 0; i < n; i++) out[i] = _sig(keys[idx[i]], h);
    }

    function delegate(uint8 d, uint8 n, uint96 amount) external {
        address who = delegators[d % delegators.length];
        address to = nodes[n % nodes.length];
        amount = uint96(bound(amount, 1e6, 1_000e6));
        vm.prank(who);
        try reg.delegate(to, amount) { done["delegate"]++; } catch {}
    }

    function undelegate(uint8 d, uint8 n, uint256 part) external {
        address who = delegators[d % delegators.length];
        address from = nodes[n % nodes.length];
        uint256 shares = reg.delegatorShares(from, who);
        if (shares == 0) return;
        vm.prank(who);
        try reg.undelegate(from, bound(part, 1, shares)) { done["undelegate"]++; } catch {}
    }

    function withdrawUndelegated(uint8 d, uint8 n) external {
        vm.prank(delegators[d % delegators.length]);
        try reg.withdrawUndelegated(nodes[n % nodes.length]) { done["withdrawUndelegated"]++; } catch {}
    }

    function settle(uint8 j, uint64 unit, uint8 mask) external {
        uint256 id = jobIds[j % jobIds.length];
        (, uint8 role,,,,,,,,,,, uint16 batchUnits) = reg.jobs(id);
        bytes32 result = keccak256(abi.encode("result", unit));
        if (role == 1) {
            address fwd = nodes[mask % nodes.length];
            bytes32 root = result;
            bytes32 r = keccak256(abi.encode(fwd, root));
            try reg.settleForward(id, unit, root, fwd, _sigs(mask | uint8(1 << (mask % nodes.length)), reg.workStatement(id, unit, r))) {
                done["settleForward"]++;
                if (batchUnits != 0) unitOnBatchJob++;
            } catch {}
        } else {
            try reg.settle(id, unit, result, _sigs(mask, reg.workStatement(id, unit, result))) {
                done["settle"]++;
                if (batchUnits != 0) unitOnBatchJob++;
            } catch {}
        }
    }

    // a batch of a batch job; batch, root and units drawn small so the same
    // batch comes up again (with the same or another root)
    function settleBatch(uint8 j, uint8 batch, uint8 rootSalt, uint8 units, uint8 mask) external {
        uint256 id = batchJobIds[j % batchJobIds.length];
        (, uint8 role,,,,,,,,,,,) = reg.jobs(id);
        uint64 b = uint64(batch % 8);
        bytes32 root = keccak256(abi.encode("root", rootSalt % 3));
        uint32 n = uint32(bound(units, 1, 8)); // over the batch size of 6 at times
        address fwd = role == 1 ? nodes[mask % nodes.length] : address(0);
        uint8 signers = role == 1 ? mask | uint8(1 << (mask % nodes.length)) : mask;
        try reg.settleBatch(id, b, root, n, fwd, _sigs(signers, _batchStatement(id, b, root, n, fwd))) {
            done["settleBatch"]++;
            bytes32 k = keccak256(abi.encode(id, b));
            if (++batchSettles[k] > 1) batchSettledTwice++;
        } catch {}
    }

    // a node reports its own double batch: it must not come out ahead
    function selfReportBatch(uint8 n, uint64 batch) external {
        uint256 i = n % nodes.length;
        address op = nodes[i];
        (,,,,, uint256 ownBefore,) = reg.nodes(op);
        uint256 balBefore = token.balanceOf(op);
        (uint256 pending,) = reg.rewards(op);
        uint256 id = 2000 + batch;
        BoatRegistry.BatchClaim memory a = BoatRegistry.BatchClaim(bytes32("one"), 3, address(0), _sig(keys[i], _batchStatement(id, batch, bytes32("one"), 3, address(0))));
        BoatRegistry.BatchClaim memory b = BoatRegistry.BatchClaim(bytes32("two"), 3, address(0), _sig(keys[i], _batchStatement(id, batch, bytes32("two"), 3, address(0))));
        vm.prank(op);
        try reg.slashDoubleBatch(op, id, batch, a, b) {
            done["selfReportBatch"]++;
            (,,,,, uint256 ownAfter,) = reg.nodes(op);
            uint256 gain = token.balanceOf(op) - balBefore;
            uint256 loss = ownBefore - ownAfter + pending;
            if (gain > loss) selfReportGain += gain - loss;
        } catch {}
    }

    function setCapacity(uint8 n, uint32 c) external {
        vm.prank(nodes[n % nodes.length]);
        try reg.setCapacity(c) { done["setCapacity"]++; } catch {}
    }

    function slash(uint8 target, uint96 amount, uint8 mask) external {
        address op = nodes[target % nodes.length];
        amount = uint96(bound(amount, 1, 20e6)); // a fault: a fifth of the minimum at most
        bytes32 reason = keccak256(abi.encode("fault", nonce++));
        try reg.slash(op, amount, reason, 0, _sigs(mask, _slashStatement(op, amount, reason, 0))) { done["slash"]++; } catch {}
    }

    // a node reports its own double work: it must not come out ahead
    function selfReport(uint8 n, uint64 unit) external {
        uint256 i = n % nodes.length;
        address op = nodes[i];
        (,,,,, uint256 ownBefore,) = reg.nodes(op);
        uint256 balBefore = token.balanceOf(op);
        (uint256 pending,) = reg.rewards(op);
        uint256 id = 1000 + unit; // no such job: a node can sign anything
        bytes memory a = _sig(keys[i], reg.workStatement(id, unit, bytes32("one")));
        bytes memory b = _sig(keys[i], reg.workStatement(id, unit, bytes32("two")));
        vm.prank(op);
        try reg.slashDoubleWork(op, id, unit, bytes32("one"), a, bytes32("two"), b) {
            done["selfReport"]++;
            (,,,,, uint256 ownAfter,) = reg.nodes(op);
            uint256 gain = token.balanceOf(op) - balBefore;
            uint256 loss = ownBefore - ownAfter + pending;
            if (gain > loss) selfReportGain += gain - loss;
        } catch {}
    }

    function withdrawRewards(uint8 n) external {
        vm.prank(nodes[n % nodes.length]);
        try reg.withdrawRewards() { done["withdrawRewards"]++; } catch {}
    }

    // the last job may close (the others keep paying)
    function closeJob() external {
        vm.prank(address(0xBEEF));
        try reg.closeJob(jobIds[jobIds.length - 1]) { done["closeJob"]++; } catch {}
    }

    // the last node may leave (the others stay, so there is work to settle)
    function unbondAndWithdraw() external {
        address op = nodes[nodes.length - 1];
        vm.startPrank(op);
        try reg.startUnbonding() {} catch {}
        try reg.withdraw() { done["withdraw"]++; } catch {}
        vm.stopPrank();
    }

    function warp(uint32 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 2 days));
    }
}

contract InvariantsTest is Test {
    BoatRegistry reg;
    TestToken token;
    Handler h;

    function setUp() public {
        token = new TestToken("Test USD", "TUSD");
        reg = new BoatRegistry(IERC20(address(token)), 100e6, 1 days, 6667, 1 hours, 1 hours, 1e6, 1 | (10 << 8) | (2 << 40));
        h = new Handler(reg, token);
        targetContract(address(h));
    }

    // everything the registry owes, from its own views
    function owed() public view returns (uint256 sum) {
        sum = reg.treasury();
        for (uint256 i = 0; i < h.nodeCount(); i++) {
            address op = h.nodes(i);
            (,,,,, uint256 stake,) = reg.nodes(op);
            (uint256 poolStake,, uint256 ubStake,,,,) = reg.pools(op);
            (uint256 pending, uint256 matured) = reg.rewards(op);
            sum += stake + poolStake + ubStake + pending + matured;
        }
        for (uint256 j = 0; j < h.jobCount(); j++) {
            (,,,,,,,, uint256 budget,,,,) = reg.jobs(h.jobIds(j));
            sum += budget;
        }
    }

    function invariant_tokensHeldEqualTokensOwed() public view {
        assertEq(token.balanceOf(address(reg)), owed(), "the registry holds what it owes");
    }

    function invariant_totalStakeIsOwnAndBondedPool() public view {
        for (uint256 i = 0; i < h.nodeCount(); i++) {
            address op = h.nodes(i);
            (,,,,, uint256 stake,) = reg.nodes(op);
            (uint256 poolStake,,,,,,) = reg.pools(op);
            assertEq(reg.totalStake(op), stake + poolStake);
        }
    }

    function invariant_nobodyGainsByReportingItself() public view {
        assertEq(h.selfReportGain(), 0, "a node reporting itself came out ahead");
    }

    function invariant_batchesSettleOnceAndNeverByUnit() public view {
        assertEq(h.batchSettledTwice(), 0, "a batch settled twice");
        assertEq(h.unitOnBatchJob(), 0, "a batch job settled a unit on its own");
    }

    function invariant_noJobOverItsRate() public view {
        for (uint256 j = 0; j < h.jobCount(); j++) {
            (,,,,,,,,, uint32 perEpoch, uint32 settledInEpoch,,) = reg.jobs(h.jobIds(j));
            assertLe(settledInEpoch, perEpoch, "a job settled more units in an epoch than its rate");
        }
    }

    // how much of each the runs did (forge test -vv)
    function afterInvariant() public view {
        string[13] memory kinds = ["delegate", "undelegate", "withdrawUndelegated", "settle", "settleForward", "settleBatch", "slash", "selfReport", "selfReportBatch", "setCapacity", "withdrawRewards", "closeJob", "withdraw"];
        for (uint256 i = 0; i < kinds.length; i++) console.log(kinds[i], h.done(bytes32(bytes(kinds[i]))));
    }
}

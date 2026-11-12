// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// forge test: the curve, enrollment and fees, publishing an epoch the
// registry settled, and claims.

import "forge-std/Test.sol";
import "boat-registry/BoatRegistry.sol";
import "boat-registry/TestToken.sol";
import "../../contracts/DepinNetwork.sol";
import "../../contracts/DepinToken.sol";

contract DepinNetworkTest is Test {
    BoatRegistry reg;
    TestToken usd;
    DepinToken rwd;
    DepinNetwork net;
    uint256[3] keys = [uint256(0xA11CE), uint256(0xB0B), uint256(0xC0FFEE)];
    bytes32 constant NET_KEY = bytes32(uint256(0x4e4554));
    uint64 constant LEN = 3600;
    uint256 job;

    function setUp() public {
        vm.warp(1_000_000);
        usd = new TestToken("Test USD", "TUSD");
        reg = new BoatRegistry(IERC20(address(usd)), 100e6, 600, 6667, 60, 60, 1e6, 0);
        for (uint256 i = 0; i < keys.length; i++) {
            address op = vm.addr(keys[i]);
            usd.mint(op, 1000e6);
            vm.startPrank(op);
            usd.approve(address(reg), type(uint256).max);
            reg.register(bytes32(i + 1), 8, 100e6);
            vm.stopPrank();
        }
        rwd = new DepinToken("Weather", "WX");
        DepinNetwork.Curve memory c;
        c.kind = 1; // halving
        c.initial = 1000e18;
        c.period = 10;
        net = new DepinNetwork(IBoatRegistry(address(reg)), NET_KEY, keccak256("config"), address(rwd), true, uint64(block.timestamp), LEN, 5e6, 3, c);
        rwd.setMinter(address(net));
        usd.mint(address(this), 1000e6);
        usd.approve(address(reg), type(uint256).max);
        BoatRegistry.JobTerms memory t = BoatRegistry.JobTerms(8, 2, 100, 0, keccak256("xid-depin/1"), 1e6, 50e6);
        job = reg.postJob(NET_KEY, t, "");
        net.attachJob(job);
    }

    function _sig(uint256 key, bytes32 h) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h)));
        return abi.encodePacked(r, s, v);
    }

    // two oracles sign the epoch statement and settle it on the registry
    function _settle(uint64 e, bytes32 root, uint256 total, uint32 count) internal {
        bytes32 result = net.epochStatement(e, root, total, count);
        bytes32 h = reg.workStatement(job, e, result);
        address a = vm.addr(keys[0]);
        address b = vm.addr(keys[1]);
        bytes[] memory sigs = new bytes[](2);
        (uint256 ka, uint256 kb) = a < b ? (keys[0], keys[1]) : (keys[1], keys[0]);
        sigs[0] = _sig(ka, h);
        sigs[1] = _sig(kb, h);
        reg.settle(job, e, result, sigs);
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function testCurves() public view {
        assertEq(net.emission(0), 1000e18);
        assertEq(net.emission(9), 1000e18);
        assertEq(net.emission(10), 500e18);
        assertEq(net.emission(25), 250e18);
        assertEq(net.rpow(0.5e18, 3), 0.125e18);
    }

    function testOtherCurves() public {
        DepinNetwork.Curve memory c;
        c.kind = 2;
        c.initial = 100e18;
        c.rate = 0.1e18;
        c.floor = 10e18;
        DepinNetwork n = new DepinNetwork(IBoatRegistry(address(reg)), NET_KEY, 0, address(rwd), false, 0, LEN, 0, 0, c);
        assertEq(n.emission(1), 90e18);
        assertEq(n.emission(2), 81e18);
        assertEq(n.emission(100), 10e18); // the floor
        c.kind = 4;
        c.untils = new uint64[](2);
        c.amounts = new uint256[](2);
        c.untils[0] = 5;
        c.untils[1] = 10;
        c.amounts[0] = 7e18;
        c.amounts[1] = 3e18;
        c.floor = 0;
        c.end = 9;
        n = new DepinNetwork(IBoatRegistry(address(reg)), NET_KEY, 0, address(rwd), false, 0, LEN, 0, 0, c);
        assertEq(n.emission(4), 7e18);
        assertEq(n.emission(5), 3e18);
        assertEq(n.emission(9), 0); // ended
        c.kind = 3;
        c.initial = 10e18;
        c.rate = 3e18;
        c.end = 0;
        n = new DepinNetwork(IBoatRegistry(address(reg)), NET_KEY, 0, address(rwd), false, 0, LEN, 0, 0, c);
        assertEq(n.emission(3), 1e18);
        assertEq(n.emission(4), 0);
    }

    function testEnrollAndFees() public {
        usd.approve(address(net), type(uint256).max);
        net.enroll(bytes32(uint256(1)));
        net.enroll(bytes32(uint256(2)));
        vm.expectRevert(bytes("enrolled"));
        net.enroll(bytes32(uint256(1)));
        net.enroll(bytes32(uint256(3)));
        vm.expectRevert(bytes("full"));
        net.enroll(bytes32(uint256(4)));
        assertEq(net.fees(), 15e6);
        (,,,,,,,, uint256 before,,,,) = reg.jobs(job);
        net.sendFees();
        (,,,,,,,, uint256 afterB,,,,) = reg.jobs(job);
        assertEq(afterB - before, 15e6);
        assertTrue(net.inEpoch(bytes32(uint256(1)), 0));
        vm.warp(block.timestamp + 10);
        net.remove(bytes32(uint256(1)));
        vm.warp(block.timestamp + LEN);
        assertTrue(net.inEpoch(bytes32(uint256(1)), 0)); // removed during epoch 0: it still counts there
        assertFalse(net.inEpoch(bytes32(uint256(1)), 1));
    }

    function testPublishAndClaim() public {
        bytes32 didA = bytes32(uint256(0xA));
        bytes32 didB = bytes32(uint256(0xB));
        address payA = address(0xAAA);
        address payB = address(0xBBB);
        bytes32 la = net.leaf(0, didA, payA, 600e18);
        bytes32 lb = net.leaf(0, didB, payB, 400e18);
        bytes32 root = _pair(la, lb);
        vm.warp(block.timestamp + LEN + 1);
        _settle(0, root, 1000e18, 2);
        vm.expectRevert(bytes("not settled on the registry"));
        net.publishEpoch(job, 0, root, 999e18, 2);
        net.publishEpoch(job, 0, root, 1000e18, 2);
        vm.expectRevert(bytes("published"));
        net.publishEpoch(job, 0, root, 1000e18, 2);
        bytes32[] memory p = new bytes32[](1);
        p[0] = lb;
        net.claim(0, didA, payA, 600e18, p);
        assertEq(rwd.balanceOf(payA), 600e18);
        vm.expectRevert(bytes("claimed"));
        net.claim(0, didA, payA, 600e18, p);
        p[0] = la;
        vm.expectRevert(bytes("proof"));
        net.claim(0, didB, payB, 401e18, p);
        net.claim(0, didB, payB, 400e18, p);
        assertEq(net.owed(), 0);
        assertEq(net.emitted(), 1000e18);
    }

    function testLimits() public {
        bytes32 root = keccak256("r");
        _settle(0, root, 1000e18, 1);
        vm.expectRevert(bytes("epoch not over"));
        net.publishEpoch(job, 0, root, 1000e18, 1);
        vm.warp(block.timestamp + LEN);
        _settle(1, root, 1001e18, 1);
        vm.warp(block.timestamp + LEN);
        vm.expectRevert(bytes("over the emission"));
        net.publishEpoch(job, 1, root, 1001e18, 1);
        vm.expectRevert(bytes("job"));
        net.publishEpoch(job + 1, 0, root, 1000e18, 1);
        // a job about another network cannot be attached
        BoatRegistry.JobTerms memory t = BoatRegistry.JobTerms(8, 2, 100, 0, keccak256("xid-depin/1"), 1e6, 50e6);
        uint256 other = reg.postJob(bytes32(uint256(7)), t, "");
        vm.expectRevert(bytes("not this network's job"));
        net.attachJob(other);
    }

    function testPrefunded() public {
        DepinNetwork.Curve memory c;
        c.initial = 10e18;
        TestToken pool = new TestToken("Pool", "P");
        DepinNetwork n = new DepinNetwork(IBoatRegistry(address(reg)), NET_KEY, 0, address(pool), false, uint64(block.timestamp), LEN, 0, 0, c);
        n.attachJob(job);
        net = n;
        vm.warp(block.timestamp + LEN);
        bytes32 root = keccak256("r");
        _settle(0, root, 10e18, 1);
        vm.expectRevert(bytes("not funded"));
        n.publishEpoch(job, 0, root, 10e18, 1);
        pool.mint(address(n), 10e18);
        n.publishEpoch(job, 0, root, 10e18, 1);
        assertEq(n.owed(), 10e18);
    }
}

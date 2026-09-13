import { extractFromSource } from '../src/extraction';
import { detectLanguage, getSupportedLanguages, isLanguageSupported } from '../src/extraction/grammars';
import { describe, expect, it } from 'bun:test';

export function registerSolidityExtractionTests(): void {


  describe('Solidity Extraction', () => {
    const code = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IVault {
    function deposit(uint256 amount) external returns (bool);
    event Deposited(address indexed user, uint256 amount);
}

library SafeMath {
    function add(uint256 a, uint256 b) internal pure returns (uint256) {
        return a + b;
    }
}

contract Vault is IVault {
    using SafeMath for uint256;

    enum Status { Active, Frozen, Closed }

    struct UserInfo {
        uint256 balance;
        uint256 lastDeposit;
    }

    IERC20 public immutable token;
    mapping(address => UserInfo) public users;
    address public owner;

    event Withdrawn(address indexed user, uint256 amount);
    error NotOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _token) {
        token = IERC20(_token);
        owner = msg.sender;
    }

    function deposit(uint256 amount) external override returns (bool) {
        users[msg.sender].balance = users[msg.sender].balance.add(amount);
        emit Deposited(msg.sender, amount);
        return true;
    }

    function withdraw(uint256 amount) external onlyOwner {
        emit Withdrawn(msg.sender, amount);
    }
}
`;

    describe('Language detection', () => {
      it('should detect Solidity files', () => {
        expect(detectLanguage('contracts/Vault.sol')).toBe('solidity');
      });

      it('should report Solidity as supported', () => {
        expect(isLanguageSupported('solidity')).toBe(true);
        expect(getSupportedLanguages()).toContain('solidity');
      });
    });

    describe('Container extraction', () => {
      it('should extract contract / interface / library as class-likes', () => {
        const result = extractFromSource('Vault.sol', code);
        // interface_declaration → interface
        const iface = result.nodes.find((n) => n.kind === 'interface' && n.name === 'IVault');
        expect(iface).toBeDefined();
        expect(iface?.language).toBe('solidity');
        // contract and library both map to 'class' (library has no special semantics
        // a class node doesn't already cover — they share methodTypes/inheritance).
        expect(result.nodes.find((n) => n.kind === 'class' && n.name === 'Vault')).toBeDefined();
        expect(result.nodes.find((n) => n.kind === 'class' && n.name === 'SafeMath')).toBeDefined();
      });

      it('should emit extends references for `is X, Y` inheritance', () => {
        // `Vault is IVault` — Solidity uses one keyword (`is`) for both class
        // extension and interface implementation, so the extractor emits `extends`
        // and the resolver's interface-impl synthesizer reclassifies to
        // `implements` based on the target node kind.
        const result = extractFromSource('Vault.sol', code);
        const extendsRefs = result.unresolvedReferences.filter(
          (r) => r.referenceKind === 'extends' && r.referenceName === 'IVault'
        );
        expect(extendsRefs).toHaveLength(1);
        const vaultNode = result.nodes.find((n) => n.kind === 'class' && n.name === 'Vault');
        expect(vaultNode).toBeDefined();
        expect(extendsRefs[0]?.fromNodeId).toBe(vaultNode!.id);
      });
    });

    describe('Method extraction', () => {
      it('should extract methods, modifiers, and constructor with signatures', () => {
        const result = extractFromSource('Vault.sol', code);
        const methods = result.nodes.filter((n) => n.kind === 'method');
        const names = methods.map((n) => n.name);
        expect(names).toContain('deposit');
        expect(names).toContain('withdraw');
        expect(names).toContain('add');
        expect(names).toContain('onlyOwner');     // modifier_definition
        expect(names).toContain('constructor');   // constructor_definition (synthetic name)

        // Signature should capture parameters + visibility + state mutability + return type.
        const add = methods.find((m) => m.name === 'add');
        expect(add?.signature).toContain('uint256 a');
        expect(add?.signature).toContain('internal');
        expect(add?.signature).toContain('pure');
        expect(add?.signature).toContain('returns (uint256)');

        // `external` visibility should map to 'public' (callable from outside the contract).
        const deposit = methods.find((m) => m.name === 'deposit');
        expect(deposit?.visibility).toBe('public');
      });
    });

    describe('Struct, enum, and field extraction', () => {
      it('should extract struct, enum, and enum members', () => {
        const result = extractFromSource('Vault.sol', code);
        expect(result.nodes.find((n) => n.kind === 'struct' && n.name === 'UserInfo')).toBeDefined();
        expect(result.nodes.find((n) => n.kind === 'enum' && n.name === 'Status')).toBeDefined();
        const enumMembers = result.nodes.filter((n) => n.kind === 'enum_member').map((n) => n.name);
        expect(enumMembers).toEqual(expect.arrayContaining(['Active', 'Frozen', 'Closed']));
      });

      it('should extract state variables, struct members, events, errors as fields', () => {
        const result = extractFromSource('Vault.sol', code);
        const fieldNames = result.nodes.filter((n) => n.kind === 'field').map((n) => n.name);
        // state variables
        expect(fieldNames).toEqual(expect.arrayContaining(['token', 'users', 'owner']));
        // struct members
        expect(fieldNames).toEqual(expect.arrayContaining(['balance', 'lastDeposit']));
        // event + error
        expect(fieldNames).toEqual(expect.arrayContaining(['Deposited', 'Withdrawn', 'NotOwner']));
      });

      it('should treat `constant_variable_declaration` as a constant, not a variable', () => {
        const constCode = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
uint256 constant FILE_CONST = 42;
`;
        const result = extractFromSource('consts.sol', constCode);
        const node = result.nodes.find((n) => n.name === 'FILE_CONST');
        expect(node?.kind).toBe('constant');
      });
    });

    describe('Import and call extraction', () => {
      it('should extract import directives with the source path as the module name', () => {
        const result = extractFromSource('Vault.sol', code);
        const imp = result.nodes.find((n) => n.kind === 'import');
        expect(imp).toBeDefined();
        expect(imp?.name).toBe('@openzeppelin/contracts/token/ERC20/IERC20.sol');
      });

      it('should produce calls refs for emit, revert, and library/method calls', () => {
        const result = extractFromSource('Vault.sol', code);
        const calls = result.unresolvedReferences
          .filter((r) => r.referenceKind === 'calls')
          .map((r) => r.referenceName);
        // emit Deposited(...)
        expect(calls).toContain('Deposited');
        // revert NotOwner()
        expect(calls).toContain('NotOwner');
        // library call: balance.add(amount) — receiver-qualified
        expect(calls.some((c) => c === 'add' || c === 'balance.add')).toBe(true);
      });

      it('should produce calls refs for modifier invocations and base-constructor invocations', () => {
        // `withdraw(...) external onlyOwner` — the modifier sits in the function
        // header, outside the body: field the call walker descends, so it goes
        // through the decorator-position walk. It must emit `calls` (not
        // `decorates`) so flow traversal rides the withdraw → onlyOwner →
        // NotOwner audit path.
        const result = extractFromSource('Vault.sol', code);
        const withdrawNode = result.nodes.find((n) => n.kind === 'method' && n.name === 'withdraw');
        const modifierCall = result.unresolvedReferences.find(
          (r) => r.referenceKind === 'calls' && r.referenceName === 'onlyOwner'
        );
        expect(modifierCall).toBeDefined();
        expect(modifierCall?.fromNodeId).toBe(withdrawNode?.id);

        // Base-constructor invocation parses as the same modifier_invocation
        // node: `constructor(address o) ERC20("T", "TOK") Ownable(o)` — the
        // constructor-chain hop.
        const ctorCode = `pragma solidity ^0.8.20;
contract MyToken is ERC20, Ownable {
    constructor(address o) ERC20("Tok", "TOK") Ownable(o) {}
    function grab(bytes32 r) external onlyRole(ADMIN_ROLE) returns (uint256) { return 1; }
}
`;
        const ctorResult = extractFromSource('MyToken.sol', ctorCode);
        const ctorCalls = ctorResult.unresolvedReferences
          .filter((r) => r.referenceKind === 'calls')
          .map((r) => r.referenceName);
        expect(ctorCalls).toEqual(expect.arrayContaining(['ERC20', 'Ownable']));
        // modifier WITH arguments still resolves to the bare modifier name
        expect(ctorCalls).toContain('onlyRole');
      });
    });
  });
}

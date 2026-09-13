import { extractFromSource } from '../src/extraction';
import { describe, expect, it } from 'bun:test';

export function registerExportedVariableExtractionTests(): void {


  describe('Exported Variable Extraction', () => {
    it('should extract exported const with call expression (Zustand store)', () => {
      const code = `
export const useUIStore = create<UIState>((set) => ({
  isOpen: false,
  toggle: () => set((s) => ({ isOpen: !s.isOpen })),
}));
`;
      const result = extractFromSource('store.ts', code);

      const varNode = result.nodes.find((n) => n.kind === 'constant' && n.name === 'useUIStore');
      expect(varNode).toBeDefined();
      expect(varNode?.isExported).toBe(true);
    });

    it('should extract exported const with object literal', () => {
      const code = `
export const config = {
  apiUrl: 'https://api.example.com',
  timeout: 5000,
};
`;
      const result = extractFromSource('config.ts', code);

      const varNode = result.nodes.find((n) => n.kind === 'constant' && n.name === 'config');
      expect(varNode).toBeDefined();
      expect(varNode?.isExported).toBe(true);
    });

    it('should extract exported const with array literal', () => {
      const code = `
export const SCREEN_NAMES = ['home', 'settings', 'profile'] as const;
`;
      const result = extractFromSource('constants.ts', code);

      const varNode = result.nodes.find((n) => n.kind === 'constant' && n.name === 'SCREEN_NAMES');
      expect(varNode).toBeDefined();
      expect(varNode?.isExported).toBe(true);
    });

    it('should extract exported const with primitive value', () => {
      const code = `
export const MAX_RETRIES = 3;
export const API_VERSION = "v2";
`;
      const result = extractFromSource('constants.ts', code);

      const variables = result.nodes.filter((n) => n.kind === 'constant');
      expect(variables).toHaveLength(2);
      expect(variables.map((n) => n.name).sort()).toEqual(['API_VERSION', 'MAX_RETRIES']);
    });

    it('should NOT duplicate arrow functions as both function and variable', () => {
      const code = `
export const useAuth = () => {
  return useContext(AuthContext);
};
`;
      const result = extractFromSource('hooks.ts', code);

      // Should be extracted as function (from arrow function handler), NOT as variable
      const funcNodes = result.nodes.filter((n) => n.kind === 'function' && n.name === 'useAuth');
      const varNodes = result.nodes.filter((n) => n.kind === 'variable' && n.name === 'useAuth');
      expect(funcNodes).toHaveLength(1);
      expect(varNodes).toHaveLength(0);
    });

    it('should extract non-exported const as non-exported variable', () => {
      const code = `
const internalConfig = {
  debug: true,
};
`;
      const result = extractFromSource('internal.ts', code);

      // Non-exported const at file level should be extracted as a constant (not exported)
      const varNodes = result.nodes.filter((n) => (n.kind === 'variable' || n.kind === 'constant') && n.name === 'internalConfig');
      expect(varNodes).toHaveLength(1);
      expect(varNodes[0]?.isExported).toBeFalsy();
    });

    it('should extract Zod schema exports', () => {
      const code = `
export const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
});
`;
      const result = extractFromSource('schemas.ts', code);

      const varNode = result.nodes.find((n) => n.kind === 'constant' && n.name === 'userSchema');
      expect(varNode).toBeDefined();
      expect(varNode?.isExported).toBe(true);
    });

    it('should extract XState machine exports', () => {
      const code = `
export const authMachine = createMachine({
  id: "auth",
  initial: "idle",
  states: {
    idle: {},
    authenticated: {},
  },
});
`;
      const result = extractFromSource('machine.ts', code);

      const varNode = result.nodes.find((n) => n.kind === 'constant' && n.name === 'authMachine');
      expect(varNode).toBeDefined();
      expect(varNode?.isExported).toBe(true);
    });

    it('should extract calls from a top-level variable initializer (issue #425)', () => {
      const code = `
import { getTokenMp } from './api/upload';

const token = getTokenMp();
`;
      const result = extractFromSource('app.ts', code);

      const call = result.unresolvedReferences.find(
        (ref) => ref.referenceKind === 'calls' && ref.referenceName === 'getTokenMp'
      );
      expect(call).toBeDefined();
    });
  });
}

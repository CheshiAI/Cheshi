import { getNodeText, getChildByField, resolveWrappedFunctionBody } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';
import { classifyTsClassMember } from './typescript';

export const javascriptExtractor: LanguageExtractor = {
  functionTypes: ['function_declaration', 'arrow_function', 'function_expression'],
  classTypes: ['class_declaration'],
  methodTypes: ['method_definition', 'field_definition'],
  // JS `field_definition` ≙ TS `public_field_definition`: plain fields are
  // properties, function-valued fields are methods (#808).
  classifyMethodNode: classifyTsClassMember,
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['import_statement'],
  callTypes: ['call_expression'],
  variableTypes: ['lexical_declaration', 'variable_declaration'],
  nameField: 'name',
  // JS `field_definition` names its key the `property` field (TS's
  // public_field_definition uses `name`). Without this, JS class fields —
  // including arrow-function handler fields — extracted no name and produced
  // no node at all (#808).
  resolveName: (node, source) => {
    if (node.type === 'field_definition') {
      const prop = getChildByField(node, 'property');
      if (prop) return getNodeText(prop, source);
    }
    return undefined;
  },
  bodyField: 'body',
  resolveBody: (node, bodyField) => {
    // field_definition (arrow function class fields) nest the body inside
    // an arrow_function or function_expression child:
    //   field_definition → arrow_function → body (statement_block)
    // Also handles wrapper patterns like: field = throttle((e) => { ... })
    //   field_definition → call_expression → arguments → arrow_function → body
    return node.type === 'field_definition' ? resolveWrappedFunctionBody(node, bodyField) : null;
  },
  paramsField: 'parameters',
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    return params ? getNodeText(params, source) : undefined;
  },
  isExported: (node, _source) => {
    let current = node.parent;
    while (current) {
      if (current.type === 'export_statement') return true;
      current = current.parent;
    }
    return false;
  },
  isAsync: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'async') return true;
    }
    return false;
  },
  isConst: (node) => {
    if (node.type === 'lexical_declaration') {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === 'const') return true;
      }
    }
    return false;
  },
  extractImport: (node, source) => {
    const sourceField = node.childForFieldName('source');
    if (sourceField) {
      const moduleName = source.substring(sourceField.startIndex, sourceField.endIndex).replace(/['"]/g, '');
      if (moduleName) {
        return { moduleName, signature: source.substring(node.startIndex, node.endIndex).trim() };
      }
    }
    return null;
  },
};

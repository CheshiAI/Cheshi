import * as path from 'path';
import type { Node as SyntaxNode } from '../web-tree-sitter';
import { getChildByField, getNodeText } from './tree-sitter-helpers';
import type { TreeSitterState } from './tree-sitter-state';

/**
   * Handle Pascal-specific AST structures.
   * Returns true if the node was fully handled and children should be skipped.
   */
export function visitPascalNode(this: TreeSitterState, node: SyntaxNode): boolean {
  const nodeType = node.type;

  // Unit/Program/Library → module node
  if (nodeType === 'unit' || nodeType === 'program' || nodeType === 'library') {
    const moduleNameNode = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'moduleName'
    );
    const name = moduleNameNode ? getNodeText(moduleNameNode, this.source) : '';
    // Fallback to filename without extension if module name is empty
    const moduleName = name || path.basename(this.filePath).replace(/\.[^.]+$/, '');
    this.createNode('module', moduleName, node);
    // Continue visiting children (interface/implementation sections)
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) this.visitNode(child);
    }
    return true;
  }

  // declType wraps declClass/declIntf/declEnum/type-alias
  // The name lives on declType, the inner node determines the kind
  if (nodeType === 'declType') {
    this.extractPascalDeclType(node);
    return true;
  }

  // declUses → import nodes for each unit name
  if (nodeType === 'declUses') {
    this.extractPascalUses(node);
    return true;
  }

  // declConsts → container; visit children for individual declConst
  if (nodeType === 'declConsts') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'declConst') {
        this.extractPascalConst(child);
      }
    }
    return true;
  }

  // declConst at top level (outside declConsts)
  if (nodeType === 'declConst') {
    this.extractPascalConst(node);
    return true;
  }

  // declTypes → container for type declarations
  if (nodeType === 'declTypes') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) this.visitNode(child);
    }
    return true;
  }

  // declVars → container for variable declarations
  if (nodeType === 'declVars') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'declVar') {
        const nameNode = getChildByField(child, 'name');
        if (nameNode) {
          const name = getNodeText(nameNode, this.source);
          this.createNode('variable', name, child);
        }
      }
    }
    return true;
  }

  // defProc in implementation section → extract calls but don't create duplicate nodes
  if (nodeType === 'defProc') {
    this.extractPascalDefProc(node);
    return true;
  }

  // declProp → property node
  if (nodeType === 'declProp') {
    const nameNode = getChildByField(node, 'name');
    if (nameNode) {
      const name = getNodeText(nameNode, this.source);
      const visibility = this.extractor!.getVisibility?.(node);
      this.createNode('property', name, node, { visibility });
    }
    return true;
  }

  // declField → field node
  if (nodeType === 'declField') {
    const nameNode = getChildByField(node, 'name');
    if (nameNode) {
      const name = getNodeText(nameNode, this.source);
      const visibility = this.extractor!.getVisibility?.(node);
      this.createNode('field', name, node, { visibility });
    }
    return true;
  }

  // declSection → visit children (propagates visibility via getVisibility)
  if (nodeType === 'declSection') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) this.visitNode(child);
    }
    return true;
  }

  // exprCall → extract function call reference
  if (nodeType === 'exprCall') {
    this.extractPascalCall(node);
    return true;
  }

  // interface/implementation sections → visit children
  if (nodeType === 'interface' || nodeType === 'implementation') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) this.visitNode(child);
    }
    return true;
  }

  // block (begin..end) → visit for calls
  if (nodeType === 'block') {
    this.visitPascalBlock(node);
    return true;
  }

  return false;
}

/**
   * Extract a Pascal declType node (class, interface, enum, or type alias)
   */
export function extractPascalDeclType(this: TreeSitterState, node: SyntaxNode): void {
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return;
  const name = getNodeText(nameNode, this.source);

  // Find the inner type declaration
  const declClass = node.namedChildren.find(
    (c: SyntaxNode) => c.type === 'declClass'
  );
  const declIntf = node.namedChildren.find(
    (c: SyntaxNode) => c.type === 'declIntf'
  );
  const typeChild = node.namedChildren.find(
    (c: SyntaxNode) => c.type === 'type'
  );

  if (declClass) {
    const classNode = this.createNode('class', name, node);
    if (classNode) {
      // Extract inheritance from typeref children of declClass
      this.extractPascalInheritance(declClass, classNode.id);
      // Visit class body
      this.nodeStack.push(classNode.id);
      for (let i = 0; i < declClass.namedChildCount; i++) {
        const child = declClass.namedChild(i);
        if (child) this.visitNode(child);
      }
      this.nodeStack.pop();
    }
  } else if (declIntf) {
    const ifaceNode = this.createNode('interface', name, node);
    if (ifaceNode) {
      // Visit interface members
      this.nodeStack.push(ifaceNode.id);
      for (let i = 0; i < declIntf.namedChildCount; i++) {
        const child = declIntf.namedChild(i);
        if (child) this.visitNode(child);
      }
      this.nodeStack.pop();
    }
  } else if (typeChild) {
    // Check if it contains a declEnum
    const declEnum = typeChild.namedChildren.find(
      (c: SyntaxNode) => c.type === 'declEnum'
    );
    if (declEnum) {
      const enumNode = this.createNode('enum', name, node);
      if (enumNode) {
        // Extract enum members
        this.nodeStack.push(enumNode.id);
        for (let i = 0; i < declEnum.namedChildCount; i++) {
          const child = declEnum.namedChild(i);
          if (child?.type === 'declEnumValue') {
            const memberName = getChildByField(child, 'name');
            if (memberName) {
              this.createNode('enum_member', getNodeText(memberName, this.source), child);
            }
          }
        }
        this.nodeStack.pop();
      }
    } else {
      // Simple type alias: type TFoo = string / type TFoo = Integer
      this.createNode('type_alias', name, node);
    }
  } else {
    // Fallback: could be a forward declaration or simple alias
    this.createNode('type_alias', name, node);
  }
}

/**
   * Extract Pascal uses clause into individual import nodes
   */
export function extractPascalUses(this: TreeSitterState, node: SyntaxNode): void {
  const importText = getNodeText(node, this.source).trim();
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'moduleName') {
      const unitName = getNodeText(child, this.source);
      this.createNode('import', unitName, child, {
        signature: importText,
      });
      // Create unresolved reference for resolution
      if (this.nodeStack.length > 0) {
        const parentId = this.nodeStack[this.nodeStack.length - 1];
        if (parentId) {
          this.unresolvedReferences.push({
            fromNodeId: parentId,
            referenceName: unitName,
            referenceKind: 'imports',
            line: child.startPosition.row + 1,
            column: child.startPosition.column,
          });
        }
      }
    }
  }
}

/**
   * Extract a Pascal constant declaration
   */
export function extractPascalConst(this: TreeSitterState, node: SyntaxNode): void {
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return;
  const name = getNodeText(nameNode, this.source);
  const defaultValue = node.namedChildren.find(
    (c: SyntaxNode) => c.type === 'defaultValue'
  );
  const sig = defaultValue ? getNodeText(defaultValue, this.source) : undefined;
  this.createNode('constant', name, node, { signature: sig });
}

/**
   * Extract Pascal inheritance (extends/implements) from declClass typeref children
   */
export function extractPascalInheritance(this: TreeSitterState, declClass: SyntaxNode, classId: string): void {
  const typerefs = declClass.namedChildren.filter(
    (c: SyntaxNode) => c.type === 'typeref'
  );
  for (let i = 0; i < typerefs.length; i++) {
    const ref = typerefs[i]!;
    const name = getNodeText(ref, this.source);
    this.unresolvedReferences.push({
      fromNodeId: classId,
      referenceName: name,
      referenceKind: i === 0 ? 'extends' : 'implements',
      line: ref.startPosition.row + 1,
      column: ref.startPosition.column,
    });
  }
}

/**
   * Extract calls and resolve method context from a Pascal defProc (implementation body).
   * Does not create a new node — the declaration was already captured from the interface section.
   */
export function extractPascalDefProc(this: TreeSitterState, node: SyntaxNode): void {
  // Find the matching declaration node by name to use as call parent
  const declProc = node.namedChildren.find(
    (c: SyntaxNode) => c.type === 'declProc'
  );
  if (!declProc) return;

  const nameNode = getChildByField(declProc, 'name');
  if (!nameNode) return;
  const fullName = getNodeText(nameNode, this.source).trim();
  // fullName is like "TAuthService.Create"
  const shortName = fullName.includes('.') ? fullName.split('.').pop()! : fullName;
  const fullNameKey = fullName.toLowerCase();
  const shortNameKey = shortName.toLowerCase();

  // Build method index on first use (O(n) once, then O(1) per lookup)
  if (!this.methodIndex) {
    this.methodIndex = new Map();
    for (const n of this.nodes) {
      if (n.kind === 'method' || n.kind === 'function') {
        const nameKey = n.name.toLowerCase();
        // Keep first seen short-name mapping to avoid silently overwriting earlier entries.
        if (!this.methodIndex.has(nameKey)) {
          this.methodIndex.set(nameKey, n.id);
        }

        // For Pascal methods, also index qualified forms (e.g. TAuthService.Create).
        if (n.kind === 'method') {
          const qualifiedParts = n.qualifiedName.split('::');
          if (qualifiedParts.length >= 2) {
            // Create suffix keys so both "Module.Class.Method" and "Class.Method" can resolve.
            for (let i = 0; i < qualifiedParts.length - 1; i++) {
              const scopedName = qualifiedParts.slice(i).join('.').toLowerCase();
              this.methodIndex.set(scopedName, n.id);
            }
          }
        }
      }
    }
  }

  let parentId =
    this.methodIndex.get(fullNameKey) ||
    this.methodIndex.get(shortNameKey);

  // No existing node? This is an implementation-only **free** procedure/function
  // (`procedure Helper; begin … end;` with no interface declaration and not a
  // class method). Create a function node so its body's calls attribute to it,
  // not to the enclosing file/module. A method (`TClass.Method`, a dotted name)
  // always has a node from its class declaration, so this only fires for free
  // routines — and the methodIndex lookup above already covers interface-declared
  // free routines, so there's no duplicate.
  if (!parentId && !fullName.includes('.')) {
    const fnNode = this.createNode('function', fullName, declProc, {
      signature: this.extractor?.getSignature?.(declProc, this.source),
      visibility: this.extractor?.getVisibility?.(declProc),
    });
    if (fnNode) {
      parentId = fnNode.id;
      this.methodIndex.set(fullNameKey, fnNode.id);
      if (!this.methodIndex.has(shortNameKey)) this.methodIndex.set(shortNameKey, fnNode.id);
    }
  }

  if (!parentId) parentId = this.nodeStack[this.nodeStack.length - 1];
  if (!parentId) return;

  // Visit the block for calls
  const block = node.namedChildren.find(
    (c: SyntaxNode) => c.type === 'block'
  );
  if (block) {
    this.nodeStack.push(parentId);
    this.visitPascalBlock(block);
    this.nodeStack.pop();
  }
}

/**
   * Extract function calls from a Pascal expression
   */
export function extractPascalCall(this: TreeSitterState, node: SyntaxNode): void {
  if (this.nodeStack.length === 0) return;
  const callerId = this.nodeStack[this.nodeStack.length - 1];
  if (!callerId) return;

  // Get the callee name — first child is typically the identifier or exprDot
  const firstChild = node.namedChild(0);
  if (!firstChild) return;

  let calleeName = '';
  if (firstChild.type === 'exprDot') {
    // Chained static-factory call: `TFoo.GetInstance().DoIt()` — the exprDot's
    // receiver is itself an `exprCall`, so the bare identifier list would
    // collapse to just `DoIt` and mis-resolve to a same-named method on an
    // unrelated class. Encode `TFoo.GetInstance().DoIt` so resolution infers
    // DoIt's class from what `TFoo.GetInstance` RETURNS (#645/#608). Only a
    // capitalized class-factory chain; a unary outer method.
    const innerCall = firstChild.namedChildren.find((c: SyntaxNode) => c.type === 'exprCall');
    const outerId = firstChild.namedChildren.filter((c: SyntaxNode) => c.type === 'identifier').pop();
    const method = outerId ? getNodeText(outerId, this.source) : '';
    if (innerCall && method && /^\w+$/.test(method)) {
      const innerFirst = innerCall.namedChild(0);
      let innerCallee = '';
      if (innerFirst?.type === 'exprDot') {
        innerCallee = innerFirst.namedChildren
          .filter((c: SyntaxNode) => c.type === 'identifier')
          .map((id: SyntaxNode) => getNodeText(id, this.source))
          .join('.');
      } else if (innerFirst?.type === 'identifier') {
        innerCallee = getNodeText(innerFirst, this.source);
      }
      // Gate on the Delphi type-naming convention — `TFoo` classes / `IFoo`
      // interfaces — so a class-factory chain re-encodes but a capitalized
      // VARIABLE/parameter chain (Pascal capitalizes locals too: `Curve.X().Y()`,
      // `Self.X().Y()`) stays bare and keeps its existing bare-name resolution.
      calleeName = innerCallee && /^[TI][A-Z]/.test(innerCallee)
        ? `${innerCallee}().${method}`
        : method;
    } else {
      // Qualified call: Obj.Method(...)
      const identifiers = firstChild.namedChildren.filter(
        (c: SyntaxNode) => c.type === 'identifier'
      );
      if (identifiers.length > 0) {
        calleeName = identifiers.map((id: SyntaxNode) => getNodeText(id, this.source)).join('.');
      }
    }
  } else if (firstChild.type === 'identifier') {
    calleeName = getNodeText(firstChild, this.source);
  }

  if (calleeName) {
    this.unresolvedReferences.push({
      fromNodeId: callerId,
      referenceName: calleeName,
      referenceKind: 'calls',
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
    });
  }

  // Also visit arguments for nested calls
  const args = node.namedChildren.find(
    (c: SyntaxNode) => c.type === 'exprArgs'
  );
  if (args) {
    this.visitPascalBlock(args);
  }
}

/**
   * Extract a PAREN-LESS Pascal method/procedure call (`Obj.Method;`,
   * `TFoo.GetInstance.DoIt;`). Pascal lets a no-arg method drop its parens, so it
   * parses as a bare `exprDot` (not an `exprCall`). A bare `exprDot` is
   * syntactically identical to a field/property access, so this is only ever
   * called for a STATEMENT-level exprDot (caller-gated): a bare `Obj.Field;`
   * statement is a no-op, so a statement-level dot expression is a call. (An
   * exprDot in assignment LHS/RHS or a condition is left alone — there it really
   * can be a field/property read.)
   */
export function extractPascalParenlessCall(this: TreeSitterState, node: SyntaxNode): void {
  if (this.nodeStack.length === 0) return;
  const callerId = this.nodeStack[this.nodeStack.length - 1];
  if (!callerId) return;

  const receiver = node.namedChild(0);
  const outerId = node.namedChildren.filter((c: SyntaxNode) => c.type === 'identifier').pop();
  const method = outerId ? getNodeText(outerId, this.source) : '';
  if (!method) return;

  let calleeName: string;
  // Chained: the receiver is itself a call — a paren-less `TFoo.GetInstance` (an
  // inner exprDot) or a paren'd `TFoo.GetInstance()` (an exprCall). Encode the
  // chain `TFoo.GetInstance().DoIt` so resolution infers DoIt's class from what
  // the factory RETURNS (#645/#608), gated on the Delphi `TFoo`/`IFoo` type
  // convention; a capitalized VARIABLE chain stays a bare method name.
  if ((receiver?.type === 'exprDot' || receiver?.type === 'exprCall') && /^\w+$/.test(method)) {
    const innerCalleeNode = receiver.type === 'exprCall' ? receiver.namedChild(0) : receiver;
    const innerCallee = !innerCalleeNode
      ? ''
      : innerCalleeNode.type === 'identifier'
        ? getNodeText(innerCalleeNode, this.source)
        : innerCalleeNode.namedChildren
          .filter((c: SyntaxNode) => c.type === 'identifier')
          .map((id: SyntaxNode) => getNodeText(id, this.source))
          .join('.');
    if (innerCallee && /^[TI][A-Z]/.test(innerCallee)) {
      calleeName = `${innerCallee}().${method}`;
      // The T/I-prefixed inner is itself a real call — record it too.
      if (receiver.type === 'exprCall') this.extractPascalCall(receiver);
      else this.extractPascalParenlessCall(receiver);
    } else {
      calleeName = method; // non-class receiver: a bare method ref (no field-access ref)
    }
  } else {
    // Simple: `Obj.Method` → the dotted name (resolves via the receiver / bare name).
    calleeName = node.namedChildren
      .filter((c: SyntaxNode) => c.type === 'identifier')
      .map((id: SyntaxNode) => getNodeText(id, this.source))
      .join('.');
  }

  if (calleeName) {
    this.unresolvedReferences.push({
      fromNodeId: callerId,
      referenceName: calleeName,
      referenceKind: 'calls',
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
    });
  }
}

/**
   * Recursively visit a Pascal block/statement tree for call expressions
   */
export function visitPascalBlock(this: TreeSitterState, node: SyntaxNode): void {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    // Function-as-value capture (#756): Pascal bodies are walked here, not
    // in visitNode/visitForCallsAndStructure, so the capture hook fires here
    // — assignment RHS is the Delphi event-wiring idiom (`OnFire := Handler`).
    this.maybeCaptureFnRefs(child, child.type);
    if (child.type === 'exprCall') {
      this.extractPascalCall(child);
      // The walker doesn't descend into a call's arguments — dispatch the
      // argument container directly (`RegisterHandler(TargetCb)` / `(@Cb)`).
      const args = child.namedChildren.find((c: SyntaxNode) => c.type === 'exprArgs');
      if (args) this.maybeCaptureFnRefs(args, 'exprArgs');
    } else if (child.type === 'exprDot') {
      // A STATEMENT-level bare exprDot is a paren-less call (`Obj.Free;`,
      // `TFoo.GetInstance.DoIt;`). Anywhere else (assignment side, condition,
      // expression) a bare exprDot is ambiguous with a field/property access,
      // so there we only descend for paren'd inner calls.
      if (node.type === 'statement') {
        this.extractPascalParenlessCall(child);
      } else {
        for (let j = 0; j < child.namedChildCount; j++) {
          const grandchild = child.namedChild(j);
          if (grandchild?.type === 'exprCall') {
            this.extractPascalCall(grandchild);
          }
        }
      }
    } else {
      this.visitPascalBlock(child);
    }
  }
}

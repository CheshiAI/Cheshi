import { extractFromSource } from '../src/extraction';
import { describe, expect, it } from 'bun:test';

export function registerKotlinExtractionTests(): void {


  describe('Kotlin Extraction', () => {
    it('should extract class declarations', () => {
      const code = `
class UserRepository(private val database: Database) {
    fun findById(id: String): User? {
        return database.query("SELECT * FROM users WHERE id = ?", id)
    }

    suspend fun save(user: User) {
        database.insert(user)
    }
}
`;
      const result = extractFromSource('UserRepository.kt', code);

      const classNode = result.nodes.find((n) => n.kind === 'class');
      expect(classNode).toBeDefined();
      expect(classNode?.name).toBe('UserRepository');
    });

    it('should extract function declarations', () => {
      const code = `
fun calculateTotal(items: List<Item>): Double {
    return items.sumOf { it.price }
}

suspend fun fetchUserData(userId: String): User {
    return api.getUser(userId)
}
`;
      const result = extractFromSource('utils.kt', code);

      const functions = result.nodes.filter((n) => n.kind === 'function');
      expect(functions.length).toBeGreaterThanOrEqual(1);
    });

    it('should detect suspend functions as async', () => {
      const code = `
suspend fun loadData(): List<String> {
    delay(1000)
    return listOf("a", "b", "c")
}
`;
      const result = extractFromSource('loader.kt', code);

      const funcNode = result.nodes.find((n) => n.kind === 'function');
      expect(funcNode).toBeDefined();
      expect(funcNode?.isAsync).toBe(true);
    });

    it('should extract fun interface declarations', () => {
      const code = `
fun interface OnObjectRetainedListener {
  fun onObjectRetained()
}
`;
      const result = extractFromSource('listener.kt', code);

      const ifaceNode = result.nodes.find((n) => n.kind === 'interface');
      expect(ifaceNode).toBeDefined();
      expect(ifaceNode?.name).toBe('OnObjectRetainedListener');

      const methodNode = result.nodes.find((n) => n.kind === 'method');
      expect(methodNode).toBeDefined();
      expect(methodNode?.name).toBe('onObjectRetained');
      expect(methodNode?.qualifiedName).toBe('OnObjectRetainedListener::onObjectRetained');
    });

    it('should extract complex fun interface with nested classes', () => {
      const code = `
fun interface EventListener {
  fun onEvent(event: Event)

  sealed class Event {
    class DumpingHeap : Event()
  }
}
`;
      const result = extractFromSource('events.kt', code);

      const ifaceNode = result.nodes.find((n) => n.kind === 'interface');
      expect(ifaceNode).toBeDefined();
      expect(ifaceNode?.name).toBe('EventListener');

      // Nested sealed class should still be extracted (as sibling due to grammar limitations)
      const eventClass = result.nodes.find((n) => n.kind === 'class' && n.name === 'Event');
      expect(eventClass).toBeDefined();

      const dumpingHeap = result.nodes.find((n) => n.kind === 'class' && n.name === 'DumpingHeap');
      expect(dumpingHeap).toBeDefined();
    });

    it('should not affect regular function declarations', () => {
      const code = `
fun interface MyCallback {
  fun invoke(value: Int)
}

fun regularFunction(): String {
  return "hello"
}
`;
      const result = extractFromSource('mixed.kt', code);

      const ifaceNode = result.nodes.find((n) => n.kind === 'interface');
      expect(ifaceNode).toBeDefined();
      expect(ifaceNode?.name).toBe('MyCallback');

      const funcNode = result.nodes.find((n) => n.kind === 'function');
      expect(funcNode).toBeDefined();
      expect(funcNode?.name).toBe('regularFunction');
    });

    it('should extract fun interface with annotation on method (Pattern 2b)', () => {
      // When the SAM method has annotations like @Throws, tree-sitter produces a different
      // misparse: function_declaration > ERROR("interface Name {") instead of
      // function_declaration > user_type("interface"). This is the OkHttp Interceptor pattern.
      const code = `
import java.io.IOException

fun interface Interceptor {
  @Throws(IOException::class)
  fun intercept(chain: Chain): Response
}
`;
      const result = extractFromSource('interceptor.kt', code);

      const ifaceNode = result.nodes.find((n) => n.kind === 'interface');
      expect(ifaceNode).toBeDefined();
      expect(ifaceNode?.name).toBe('Interceptor');
    });

    it('should extract methods from interface with nested fun interface', () => {
      // When an interface contains a nested `fun interface`, tree-sitter misparsed
      // the parent body as ERROR. Methods inside should still be extracted.
      const code = `
interface WebSocket {
  fun request(): Request
  fun send(text: String): Boolean
  fun cancel()
  fun interface Factory {
    fun newWebSocket(request: Request): WebSocket
  }
}
`;
      const result = extractFromSource('websocket.kt', code);

      const wsIface = result.nodes.find((n) => n.kind === 'interface' && n.name === 'WebSocket');
      expect(wsIface).toBeDefined();

      const methods = result.nodes.filter((n) => n.kind === 'method' && n.qualifiedName?.startsWith('WebSocket::'));
      const methodNames = methods.map((m) => m.name);
      expect(methodNames).toContain('request');
      expect(methodNames).toContain('send');
      expect(methodNames).toContain('cancel');
    });

    it('wraps top-level declarations in a namespace from package_header', () => {
      const code = `
package com.example.foo

class Bar {
  fun greet(): String = "hi"
}

fun util(): Int = 42
`;
      const result = extractFromSource('Bar.kt', code);

      const ns = result.nodes.find((n) => n.kind === 'namespace');
      expect(ns?.name).toBe('com.example.foo');

      const cls = result.nodes.find((n) => n.kind === 'class' && n.name === 'Bar');
      expect(cls?.qualifiedName).toBe('com.example.foo::Bar');

      const greet = result.nodes.find((n) => n.kind === 'method' && n.name === 'greet');
      expect(greet?.qualifiedName).toBe('com.example.foo::Bar::greet');

      const util = result.nodes.find((n) => n.kind === 'function' && n.name === 'util');
      expect(util?.qualifiedName).toBe('com.example.foo::util');
    });

    it('handles a single-segment package', () => {
      const code = `
package foo

class Bar
`;
      const result = extractFromSource('Bar.kt', code);
      const cls = result.nodes.find((n) => n.kind === 'class' && n.name === 'Bar');
      expect(cls?.qualifiedName).toBe('foo::Bar');
    });

    it('does not wrap when no package is declared', () => {
      const code = `
class Bar {
  fun greet() = "hi"
}
`;
      const result = extractFromSource('Bar.kt', code);
      expect(result.nodes.find((n) => n.kind === 'namespace')).toBeUndefined();
      const cls = result.nodes.find((n) => n.kind === 'class' && n.name === 'Bar');
      expect(cls?.qualifiedName).toBe('Bar');
    });
  });
}

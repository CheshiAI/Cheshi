export type GroupBy = 'directory' | 'language' | 'kind';

export interface Stats {
  nodeCount: number;
  edgeCount: number;
  fileCount: number;
  lastUpdated: number;
  nodesByKind: Record<string, number>;
  edgesByKind: Record<string, number>;
  filesByLanguage: Record<string, number>;
}

export interface Meta {
  projectId: string;
  projectRoot: string;
  stats: Stats;
  lastIndexed: number | null;
  directories: string[];
  languages: string[];
  nodeKinds: string[];
  edgeKinds: string[];
}

export interface ProjectOption {
  id: string;
  name: string;
  projectRoot: string;
}

export interface SearchResult {
  id: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  kind: string;
  language: string;
  startLine: number;
  score: number;
}

export interface GraphNode {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  group: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: string;
  line?: number;
}

export interface GraphSlice {
  rootId: string;
  depth: number;
  truncated: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface Relation {
  id: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  kind: string;
  edge: string;
}

export interface NodeDetails {
  node: GraphNode;
  code: string | null;
  callers: Relation[];
  callees: Relation[];
}

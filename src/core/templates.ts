import type { DiagramKind, DiagramTemplate } from '../shared/protocol';
import { supportsNativeKind } from './coverage';
import { familyFor, nativeFamilies } from './families/registry';

const uml = (content: string) => `@startuml\n${content}\n@enduml\n`;
const wrapped = (kind: string, content: string) => `@start${kind}\n${content}\n@end${kind}\n`;

/** Original starter documents; these are not copied from another extension or example library. */
const baseTemplates: DiagramTemplate[] = [
  { kind: 'class', label: 'Class', description: 'Classes, interfaces, members, and inheritance', palette: ['class', 'interface', 'abstract class', 'enum', 'annotation', 'package', 'note'], source: uml('class "Order" as Order {\n  +number: String\n  +submit()\n}\nclass "Line item" as LineItem {\n  +quantity: Integer\n}\nOrder "1" *-- "many" LineItem : contains') },
  { kind: 'object', label: 'Object', description: 'Instances and their values', palette: ['object', 'note'], source: uml('object "order: Order" as order {\n  number = "A-101"\n}\nobject "item: LineItem" as item {\n  quantity = 2\n}\norder --> item : contains') },
  { kind: 'sequence', label: 'Sequence', description: 'Participants and ordered messages', palette: ['participant', 'actor', 'boundary', 'control', 'entity', 'database', 'collections', 'queue'], source: uml('actor "Customer" as customer\nparticipant "Checkout" as checkout\nparticipant "Inventory" as inventory\ncustomer -> checkout : Place order\ncheckout -> inventory : Reserve items\ninventory --> checkout : Reserved\ncheckout --> customer : Confirmation') },
  { kind: 'usecase', label: 'Use case', description: 'Actors and system capabilities', palette: ['actor', 'usecase', 'rectangle', 'note'], source: uml('left to right direction\nactor "Customer" as customer\nusecase "Place order" as placeOrder\nusecase "Track delivery" as trackDelivery\ncustomer --> placeOrder\ncustomer --> trackDelivery') },
  { kind: 'component', label: 'Component', description: 'Software components and dependencies', palette: ['component', 'interface', 'database', 'package', 'note'], source: uml('component "Storefront" as storefront\ncomponent "Order service" as orders\ndatabase "Order store" as store\nstorefront --> orders : HTTPS\norders --> store : SQL') },
  { kind: 'deployment', label: 'Deployment', description: 'Nodes, artifacts, and infrastructure', palette: ['node', 'artifact', 'database', 'cloud', 'component', 'queue', 'folder', 'file', 'note'], source: uml('node "Application host" as host\nartifact "Order service" as service\ndatabase "Orders" as orders\nhost --> service : deploys\nservice --> orders : reads / writes') },
  { kind: 'state', label: 'State machine', description: 'States, transitions, and lifecycle', palette: ['state', 'note'], source: uml('[*] --> Draft\nstate "Draft" as Draft\nstate "Submitted" as Submitted\nstate "Delivered" as Delivered\nDraft --> Submitted : submit\nSubmitted --> Delivered : deliver\nDelivered --> [*]') },
  { kind: 'activity', label: 'Activity', description: 'Actions, decisions, and workflow', palette: ['activity', 'decision'], source: uml('start\n:Receive order;\nif (Items available?) then (yes)\n  :Reserve stock;\nelse (no)\n  :Notify customer;\nendif\n:Record result;\nstop') },
  { kind: 'entity', label: 'Entity relationship', description: 'Tables, keys, and cardinality', palette: ['entity', 'note'], source: uml('entity "Customer" as Customer {\n  *id: UUID\n  --\n  name: String\n}\nentity "Order" as Order {\n  *id: UUID\n  --\n  customerId: UUID\n}\nCustomer ||--o{ Order : places') },
  { kind: 'mindmap', label: 'Mind map', description: 'Ideas in a hierarchy', palette: ['idea'], source: wrapped('mindmap', '* Product launch\n** Design\n*** Prototype\n** Engineering\n*** Build\n** Operations') },
  { kind: 'wbs', label: 'Work breakdown', description: 'Break down deliverables and tasks', palette: ['task'], source: wrapped('wbs', '* Release\n** Plan\n*** Scope\n*** Schedule\n** Deliver\n*** Review') },
  { kind: 'timing', label: 'Timing', description: 'Signals and states over time', palette: [], source: uml('robust "Order" as order\nconcise "Warehouse" as warehouse\n@0\norder is Pending\nwarehouse is Idle\n@10\norder is Confirmed\nwarehouse is Picking\n@30\norder is Shipped\nwarehouse is Idle') },
  { kind: 'gantt', label: 'Gantt', description: 'Tasks, durations, and dependencies', palette: [], source: wrapped('gantt', 'Project starts 2026-01-05\n[Design] lasts 5 days\n[Implementation] lasts 10 days\n[Implementation] starts at [Design]\'s end\n[Review] lasts 2 days\n[Review] starts at [Implementation]\'s end') },
  { kind: 'network', label: 'Network', description: 'Networks, hosts, and addresses', palette: [], source: wrapped('nwdiag', 'nwdiag {\n  network internal {\n    address = "10.0.0.0/24";\n    gateway [address = "10.0.0.1"];\n    app [address = "10.0.0.10"];\n    database [address = "10.0.0.20"];\n  }\n}') },
  { kind: 'salt', label: 'Wireframe / Salt', description: 'User interface mockups', palette: [], source: wrapped('salt', '{\n  <b>New order\n  Customer | "Name             "\n  Product | ^Select a product^\n  [ ] Express shipping\n  [Cancel] | [Create order]\n}') },
  { kind: 'json', label: 'JSON', description: 'Structured JSON data', palette: [], source: wrapped('json', '{\n  "order": {\n    "number": "A-101",\n    "items": ["Notebook", "Pen"],\n    "confirmed": true\n  }\n}') },
  { kind: 'yaml', label: 'YAML', description: 'Structured YAML data', palette: [], source: wrapped('yaml', 'order:\n  number: A-101\n  items:\n    - Notebook\n    - Pen\n  confirmed: true') },
  { kind: 'ditaa', label: 'Ditaa', description: 'Diagrams drawn as ASCII art', palette: [], source: wrapped('ditaa', '+---------+     +---------+\n| Request |---->| Service |\n+---------+     +----+----+\n                    |\n                    v\n               +---------+\n               | Storage |\n               +---------+') },
  { kind: 'c4', label: 'C4', description: 'System context, containers, and components', palette: [], source: uml('!include <C4/C4_Container>\nPerson(customer, "Customer", "Places orders")\nSystem_Boundary(store, "Online store") {\n  Container(web, "Storefront", "Web application", "Accepts orders")\n  ContainerDb(db, "Orders", "Database", "Stores purchases")\n}\nRel(customer, web, "Uses")\nRel(web, db, "Reads and writes")') },
  { kind: 'archimate', label: 'ArchiMate', description: 'Enterprise architecture elements', palette: [], source: uml('!include <archimate/Archimate>\nBusiness_Actor(customer, "Customer")\nBusiness_Process(ordering, "Place an order")\nApplication_Service(service, "Ordering service")\nRel_Assignment(customer, ordering, "performs")\nRel_Serving(service, ordering, "supports")') },
  { kind: 'chen', label: 'Chen ER', description: 'Conceptual entities and relationships', palette: [], source: wrapped('chen', 'entity CUSTOMER {\n  Id <<key>>\n  Name\n}\nentity ORDER {\n  Number <<key>>\n}\nrelationship PLACES {\n}\nCUSTOMER -1- PLACES\nPLACES -N- ORDER') },
  { kind: 'ebnf', label: 'EBNF', description: 'Grammar and syntax diagrams', palette: [], source: wrapped('ebnf', 'order = "order", identifier, ":", item, { ",", item };\nidentifier = letter, { letter | digit };\nitem = "notebook" | "pen";') },
  { kind: 'regex', label: 'Regular expression', description: 'Railroad diagrams for patterns', palette: [], source: wrapped('regex', '[A-Z]{2}-[0-9]{4}') },
  { kind: 'math', label: 'Math', description: 'AsciiMath formulas', palette: [], source: wrapped('math', 'total = sum_(i=1)^n price_i * quantity_i') },
  { kind: 'latex' as DiagramKind, label: 'LaTeX formula', description: 'Mathematical typesetting', palette: [], source: wrapped('latex', '\\sum_{i=1}^{n} p_i q_i') },
  { kind: 'dot' as DiagramKind, label: 'Graphviz DOT', description: 'General directed graphs', palette: [], source: wrapped('dot', 'digraph order {\n  rankdir=LR;\n  request -> validation -> storage;\n}') },
  { kind: 'board', label: 'Board', description: 'Columns of related work', palette: [], source: wrapped('board', 'Backlog\n+ Design checkout\n+ Model inventory\nIn progress\n+ Build storefront\nDone\n+ Define scope') },
  { kind: 'git', label: 'Git history', description: 'A graph from git log output', palette: [], source: wrapped('git', '* a1b2c3d (HEAD -> main) Add checkout\n* d4e5f6a Model inventory\n* b7c8d9e Create project') },
];

export const templates: DiagramTemplate[] = [...baseTemplates.filter(template => !familyFor(template.kind)), { kind: 'sdl', label: 'SDL', description: 'Signals, tasks, procedures, and process flow', palette: ['sdl-input', 'sdl-output', 'sdl-procedure', 'sdl-task', 'sdl-save', 'sdl-load', 'sdl-continuous', 'decision'], source: uml('start\n:Receive request; <<input>>\n:Validate request; <<task>>\n:Store request; <<procedure>>\n:Send response; <<output>>\nstop') }, ...nativeFamilies.flatMap(family => family.templates)];
for (const template of templates) {
  if (template.kind === 'deployment') template.palette = ['node', 'artifact', 'database', 'cloud', 'component', 'queue', 'folder', 'file', 'storage', 'stack', 'agent', 'person', 'process', 'hexagon', 'circle', 'note'];
  if (template.kind === 'activity') template.palette = ['activity', 'decision', 'while', 'repeat', 'fork', 'partition'];
  if (template.kind === 'sequence') template.palette.push('note', 'alt', 'loop', 'opt', 'divider');
}
export const nativeTemplates = templates.filter(template => supportsNativeKind(template.kind));
/** Reference-only catalogue for explaining gaps; these types cannot be created graphically. */
export const unsupportedTemplates = templates.filter(template => !supportsNativeKind(template.kind));

export function getTemplate(kind: DiagramKind): DiagramTemplate | undefined {
  return templates.find(template => template.kind === (kind === 'wireframe' ? 'salt' : kind));
}

export function getNativeTemplate(kind: DiagramKind): DiagramTemplate | undefined {
  return nativeTemplates.find(template => template.kind === kind);
}

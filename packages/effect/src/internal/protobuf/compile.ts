// Compiles a schema AST, after `toProtobufAST`, into its layout, and rejects
// schemas without a protobuf mapping. This and `schema.ts` are the only parts
// of the codec that read schemas.

import * as SchemaAST from "../../SchemaAST.ts"
import type {
  Absent,
  Case,
  Enum,
  MapField,
  Message,
  MessageType,
  Oneof,
  Root,
  Scalar,
  Slot,
  SymbolType,
  Type
} from "./layout.ts"
import {
  addSlot,
  BOX_VALUE,
  describeKey,
  finishMessage,
  isPackable,
  layoutError,
  makeMessage,
  scalar,
  TUPLE_REST
} from "./layout.ts"
import * as S from "./schema.ts"
import * as Wire from "./wire.ts"
import * as Wkt from "./wkt.ts"

// Messages by the AST body they are compiled from, so that a message used at
// several positions, or recursively, is compiled once.
interface Compiler {
  readonly structs: Map<SchemaAST.AST, Message>
  readonly tuples: Map<SchemaAST.AST, Message>
  readonly boxes: Map<SchemaAST.AST, Message>
  readonly wrappers: Map<string, MessageType>
}

/** @internal */
export function compile(ast: SchemaAST.AST): Root {
  const c: Compiler = { structs: new Map(), tuples: new Map(), boxes: new Map(), wrappers: new Map() }
  const resolved = S.resolveEncoded(ast)
  const node = resolved.ast
  if (S.isNullish(node)) {
    return { _tag: "Constant", wireType: Wire.WIRE_LEN, value: node._tag === "Null" ? null : undefined }
  }
  // A record whose values are numbered is a message of maps.
  if (
    node._tag === "Objects" && node.indexSignatures.length > 0 && resolved.annotations[S.WKT_KEY] === undefined &&
    node.indexSignatures.every((signature) => S.getFieldAnnotation(signature.type) !== undefined)
  ) {
    return messageType(compileStruct(c, node, resolved.identifier))
  }
  const root = compileValue(c, resolved, "the root schema")
  if (root._tag === "Message" || root._tag === "Converted") return root
  // Any other root is the value of a box, like the google.protobuf wrappers.
  return box(c, ast, "the root schema")
}

function messageType(message: Message): MessageType {
  return { _tag: "Message", wireType: Wire.WIRE_LEN, message }
}

function compileStruct(c: Compiler, ast: SchemaAST.Objects, identifier: string | undefined): Message {
  const owner = SchemaAST.getContextOwner(ast)
  const cached = c.structs.get(owner)
  if (cached !== undefined) return cached
  const message = makeMessage(identifier ?? "message", "struct")
  c.structs.set(owner, message)
  for (const ps of ast.propertySignatures) message.declared.add(ps.name)
  for (const ps of ast.propertySignatures) {
    const slot = compileSlot(c, message, ps.name, ps.type, `property ${describeKey(ps.name)} of ${message.name}`)
    if (slot !== undefined) addSlot(message, slot)
  }
  const earlier: Array<SchemaAST.IndexSignature> = []
  for (const signature of ast.indexSignatures) {
    const where = `index signature of ${message.name}`
    const annotation = S.getFieldAnnotation(signature.type)
    if (annotation === undefined) {
      throw layoutError(`${where} has no field number; annotate the record value with Protobuf.field(n)`)
    }
    checkOptions(annotation, "map", where)
    const claimed = earlier.slice()
    const map = compileMap(c, signature, where)
    addSlot(message, {
      _tag: "Rest",
      number: annotation.number,
      keyType: map.keyType,
      value: map.value,
      optionalValues: map.optionalValues,
      keysOf: (obj) => SchemaAST.getIndexSignatureKeys(obj, signature.parameter),
      owns: (key) =>
        !message.declared.has(key) &&
        !claimed.some((other) => SchemaAST.getIndexSignatureKeys({ [key]: null }, other.parameter).length > 0)
    })
    earlier.push(signature)
  }
  return finishMessage(message)
}

function compileTuple(c: Compiler, ast: SchemaAST.Arrays, where: string): Message {
  const owner = SchemaAST.getContextOwner(ast)
  const cached = c.tuples.get(owner)
  if (cached !== undefined) return cached
  const message = makeMessage(where, "tuple", { elements: ast.elements.length })
  c.tuples.set(owner, message)
  ast.elements.forEach((element, i) => {
    const slot = compileSlot(c, message, i, element, `element ${i} of ${where}`)
    if (slot !== undefined) addSlot(message, slot)
  })
  if (ast.rest.length > 1) throw layoutError(`${where} has elements after its rest element`)
  if (ast.rest.length === 1) {
    const element = compileValue(c, S.resolveEncoded(ast.rest[0]), `rest element of ${where}`)
    addSlot(message, {
      _tag: "Repeated",
      key: TUPLE_REST,
      guarded: false,
      number: ast.elements.length + 1,
      element,
      absent: "zero",
      nullable: false,
      packed: isPackable(element),
      delimited: false
    })
  }
  return finishMessage(message)
}

// A synthesized message `{ value = 1 }` for a value that cannot be a field on
// its own: a collection, a union, or an optional value in an element, map
// value, oneof case, or root position.
function compileBox(c: Compiler, ast: SchemaAST.AST, where: string): Message {
  const owner = SchemaAST.getContextOwner(ast)
  const cached = c.boxes.get(owner)
  if (cached !== undefined) return cached
  const message = makeMessage(where, "box")
  c.boxes.set(owner, message)
  addSlot(message, compileSlot(c, message, BOX_VALUE, ast, where)!)
  return finishMessage(message)
}

function box(c: Compiler, ast: SchemaAST.AST, where: string): MessageType {
  return messageType(compileBox(c, ast, where))
}

const BOX_ANNOTATION: S.FieldAnnotation = { number: 1, packed: undefined, presence: undefined, encoding: undefined }

// Compiles a struct property, a tuple element (numbered by its position), or
// the value of a box (field 1). Optional and nullable values, and unions, are
// oneofs or explicit-presence fields of struct properties and boxes; in a
// tuple element, they are boxed.
function compileSlot(
  c: Compiler,
  message: Message,
  key: PropertyKey,
  type: SchemaAST.AST,
  where: string
): Slot | undefined {
  const isElement = message.shape === "tuple"
  const fixed: S.FieldAnnotation | undefined = isElement
    ? {
      number: (key as number) + 1,
      packed: undefined,
      presence: SchemaAST.isOptional(type) ? undefined : "always",
      encoding: undefined
    }
    : message.shape === "box"
    ? BOX_ANNOTATION
    : undefined
  let annotation = fixed ?? S.getFieldAnnotation(type)
  let resolved = S.resolveEncoded(type)
  let ast = resolved.ast
  const guarded = isGuarded(key)

  if (resolved.annotations[S.UNKNOWN_KEY] === true && message.shape === "struct") {
    if (annotation !== undefined) throw layoutError(`${where} holds unknown fields and takes no field number`)
    if (message.unknown !== undefined) throw layoutError(`${message.name} has several UnknownFields properties`)
    message.unknown = { key, optional: SchemaAST.isOptional(type) }
    return undefined
  }

  const constant = constantOf(ast)
  if (constant !== undefined) {
    // A tuple element is numbered by its position, so a nullish one stays a
    // constant too.
    if (annotation === undefined || (isElement && S.isNullish(ast))) {
      message.constants.push([key, constant.value])
      return undefined
    }
    if (S.isNullish(ast)) throw layoutError(`${where} is ${ast._tag}, which has no wire representation`)
    const value: Type = ast._tag === "Literal" ? literalScalar(ast.literal) : SYMBOL
    checkOptions(annotation, "singular", where)
    checkDelimited(annotation, value, where)
    return {
      _tag: "Singular",
      key,
      guarded,
      number: annotation.number,
      type: value,
      // An optional constant is written when present, like any optional field.
      absent: SchemaAST.isOptional(type) ? "omit" : "constant",
      nullable: false,
      always: true,
      delimited: false,
      constant: constant.value
    }
  }

  let absent: Absent | undefined = SchemaAST.isOptional(type) ? "omit" : undefined
  let nullable = false
  let literals: ReadonlyArray<SchemaAST.AST> | undefined
  if (!isElement) {
    if (ast._tag === "Declaration" && S.representationId(ast) === "effect/schema/Option") {
      absent = "none"
      resolved = S.resolveEncoded(ast.typeParameters[0])
      ast = resolved.ast
    }
    // Nullish members make the field explicit-presence. The other members are
    // a oneof, unless they are literals.
    while (ast._tag === "Union") {
      const members = S.flattenUnion(ast)
      const values = members.filter((member) => !S.isNullish(S.resolveEncoded(member).ast))
      for (const member of members) {
        if (!values.includes(member) && S.getFieldAnnotation(member) !== undefined) {
          throw layoutError(`${where} has a numbered nullish member; it makes the field optional and takes no number`)
        }
      }
      if (values.length < members.length) {
        const hasNull = members.some((member) => S.resolveEncoded(member).ast._tag === "Null")
        nullable ||= hasNull
        absent ??= hasNull ? "null" : "undefined"
        if (values.length === 1) {
          if (fixed === undefined) annotation ??= S.getFieldAnnotation(values[0])
          const inner = S.resolveEncoded(values[0])
          resolved = { ...inner, annotations: { ...inner.annotations, ...resolved.annotations } }
          ast = resolved.ast
          continue
        }
      }
      if (values.length === 0) throw layoutError(`${where} has no protobuf mapping for a nullish union`)
      if (S.isLiteralUnion(values)) {
        literals = values
        break
      }
      if (annotation !== undefined && fixed === undefined) {
        throw layoutError(`${where} is a oneof; number its members instead of the property`)
      }
      return compileOneof(c, key, values, absent ?? "required", nullable, where)
    }
  }

  if (annotation === undefined) {
    throw layoutError(`${where} has no field number; annotate it with Protobuf.field(n)`)
  }
  const number = annotation.number
  const isWkt = resolved.annotations[S.WKT_KEY] !== undefined
  // Options are the schema's, not those of a position.
  const options = fixed === undefined ? annotation : undefined

  if (!isWkt && ast._tag === "Arrays" && isUniformArray(ast)) {
    const element = compileValue(c, S.resolveEncoded(ast.rest[0]), `${where} (element)`)
    if (options !== undefined) checkOptions(options, "repeated", where)
    if (annotation.packed === true && !isPackable(element)) throw layoutError(`${where} cannot be packed`)
    checkDelimited(annotation, element, where)
    return {
      _tag: "Repeated",
      key,
      guarded,
      number,
      element,
      absent: absent ?? "zero",
      nullable,
      packed: annotation.packed ?? isPackable(element),
      delimited: annotation.encoding === "delimited"
    }
  }
  if (!isWkt && ast._tag === "Objects" && ast.propertySignatures.length === 0 && ast.indexSignatures.length === 1) {
    if (options !== undefined) checkOptions(options, "map", where)
    return {
      _tag: "Map",
      key,
      guarded,
      number,
      absent: absent ?? "zero",
      nullable,
      ...compileMap(c, ast.indexSignatures[0], where)
    }
  }

  const value = literals === undefined ? compileValue(c, resolved, where) : literalValue(literals, resolved, where)
  if (options !== undefined) checkOptions(options, "singular", where)
  checkDelimited(annotation, value, where)
  absent ??= value._tag === "Scalar" || value._tag === "Enum" ? "zero" : "required"
  if (options?.presence !== undefined && absent !== "zero") {
    throw layoutError(`${where} has explicit presence; only implicit-presence fields take presence "always"`)
  }
  return {
    _tag: "Singular",
    key,
    guarded,
    number,
    type: value,
    absent,
    nullable,
    always: annotation.presence === "always",
    delimited: annotation.encoding === "delimited",
    constant: undefined
  }
}

function compileMap(
  c: Compiler,
  signature: SchemaAST.IndexSignature,
  where: string
): Pick<MapField, "keyType" | "value" | "optionalValues"> {
  const optionalValues = SchemaAST.isOptional(signature.type)
  return {
    keyType: compileMapKey(S.resolveEncoded(signature.parameter), where),
    // `undefined` values are left out, so they need no representation.
    value: compileValue(
      c,
      S.resolveEncoded(optionalValues ? withoutUndefined(signature.type) : signature.type),
      `${where} (map value)`
    ),
    optionalValues
  }
}

function compileOneof(
  c: Compiler,
  key: PropertyKey,
  members: ReadonlyArray<SchemaAST.AST>,
  absent: Absent,
  nullable: boolean,
  where: string
): Oneof {
  const cases: Array<Case> = []
  const byNumber = new Map<number, Case>()
  const oneof: Oneof = {
    _tag: "Oneof",
    key,
    guarded: isGuarded(key),
    absent,
    nullable,
    cases,
    tagged: true,
    select: (value) => value instanceof S.CaseValue ? byNumber.get(value.number) : undefined,
    mismatch: "value matches no oneof case"
  }
  members.forEach((member, i) => {
    const tagged = S.getTaggedCase(member)
    if (tagged === undefined) {
      throw layoutError(
        `member ${i} of ${where} is not a oneof case; annotate it with Protobuf.field(n), ` +
          `or make it a tagged struct with a single numbered property`
      )
    }
    let annotation = S.getFieldAnnotation(tagged.member)
    let value = tagged.member
    let unwrap: S.StructCase | undefined
    if (annotation === undefined) {
      unwrap = S.getStructCase(S.resolveEncoded(tagged.member).ast)!
      if (SchemaAST.isOptional(unwrap.type)) {
        throw layoutError(`member ${i} of ${where} has an optional property; the property of a oneof case is required`)
      }
      annotation = unwrap.annotation
      value = unwrap.type
    }
    // A literal case is an empty message: its presence is the value.
    const resolved = S.resolveEncoded(value)
    const constant = constantOf(resolved.ast)
    const type: Type = constant === undefined
      ? compileValue(c, resolved, where)
      : { _tag: "Constant", wireType: Wire.WIRE_LEN, value: constant.value }
    checkOptions(annotation, "case", where)
    checkDelimited(annotation, type, where)
    const field: Case = {
      _tag: "Case",
      oneof,
      number: annotation.number,
      type,
      delimited: annotation.encoding === "delimited",
      unwrap
    }
    cases.push(field)
    byNumber.set(field.number, field)
  })
  return oneof
}

const WRAPPED_SCALARS = new Set<S.ScalarName>([
  "double",
  "float",
  "int64",
  "uint64",
  "int32",
  "uint32",
  "bool",
  "string",
  "bytes"
])

function compileValue(c: Compiler, resolved: S.Resolved, where: string): Type {
  switch (resolved.annotations[S.WKT_KEY]) {
    case "struct":
      return Wkt.Struct
    case "listValue":
      return Wkt.ListValue
  }
  const value = compileBareValue(c, resolved, where)
  if (resolved.annotations[S.WRAPPER_KEY] !== true) return value
  if (value._tag !== "Scalar" || !WRAPPED_SCALARS.has(value.scalar)) {
    throw layoutError(
      `${where} has no google.protobuf wrapper type for ${value._tag === "Scalar" ? value.scalar : resolved.ast._tag}`
    )
  }
  return wrapper(c, value)
}

// A `google.protobuf` wrapper is a box of the scalar: its zero value is not
// written, but the wrapper itself is.
function wrapper(c: Compiler, value: Scalar): MessageType {
  const id = `${value.scalar}${value.asNumber ? "/number" : ""}`
  let out = c.wrappers.get(id)
  if (out === undefined) {
    const message = makeMessage(`google.protobuf wrapper of ${value.scalar}`, "box")
    addSlot(message, {
      _tag: "Singular",
      key: BOX_VALUE,
      guarded: false,
      number: 1,
      type: value,
      absent: "zero",
      nullable: false,
      always: false,
      delimited: false,
      constant: undefined
    })
    c.wrappers.set(id, out = messageType(finishMessage(message)))
  }
  return out
}

const SYMBOL: SymbolType = { _tag: "Symbol", wireType: Wire.WIRE_LEN }

function compileBareValue(c: Compiler, resolved: S.Resolved, where: string): Type {
  const ast = resolved.ast
  const declared = resolved.annotations[S.SCALAR_KEY] as S.ScalarName | undefined
  switch (ast._tag) {
    case "String":
    case "TemplateLiteral":
      return scalar("string")
    case "Boolean":
      return scalar("bool")
    case "Number": {
      const s = declared ?? "double"
      if (s === "bool" || s === "string" || s === "bytes") throw layoutError(`${where} is a number, not ${s}`)
      return scalar(s, S.is64Bit(s))
    }
    case "BigInt": {
      const s = declared ?? "int64"
      if (!S.is64Bit(s)) throw layoutError(`${where} is a bigint, not ${s}`)
      return scalar(s)
    }
    case "Literal":
      return literalScalar(ast.literal)
    case "Symbol":
    case "UniqueSymbol":
      return SYMBOL
    case "Enum": {
      const mapping = resolved.annotations[S.ENUM_KEY] as Readonly<Record<string, number>> | undefined
      if (mapping !== undefined) return mappedEnum(ast.enums.map(([, value]) => value), mapping, where)
      for (const [name, value] of ast.enums) {
        if (typeof value !== "number" || !Wire.isInt32(value)) {
          throw layoutError(
            `${where} has enum member ${name} without a 32-bit integer value; annotate it with Protobuf.enumNumbers`
          )
        }
      }
      return OWN_NUMBERS
    }
    case "Union": {
      const members = S.flattenUnion(ast)
      return S.isLiteralUnion(members) ? literalValue(members, resolved, where) : box(c, ast, where)
    }
    case "Objects":
      if (ast.propertySignatures.length === 0 && ast.indexSignatures.length === 1) return box(c, ast, where)
      return messageType(compileStruct(c, ast, resolved.identifier))
    case "Arrays":
      if (isUniformArray(ast)) return box(c, ast, where)
      return messageType(compileTuple(c, ast, where))
    case "Declaration":
      switch (S.representationId(ast)) {
        case "effect/schema/DateTimeUtc":
          return Wkt.Timestamp
        case "effect/schema/Date":
          return Wkt.Date
        case "effect/schema/Duration":
          return Wkt.Duration
        case "effect/schema/Uint8Array":
          return scalar("bytes")
        case "effect/schema/Json":
        case "effect/schema/MutableJson":
          return Wkt.Value
        case "effect/schema/Option":
          return box(c, ast, where)
      }
      throw layoutError(`${where} is a declaration without a protobuf mapping or codec annotation`)
    case "Unknown":
    case "Any":
    case "ObjectKeyword":
      return Wkt.Value
    default:
      throw layoutError(`${where} has no protobuf mapping for ${ast._tag}`)
  }
}

const OWN_NUMBERS: Enum = { _tag: "Enum", wireType: Wire.WIRE_VARINT, toNumber: undefined, fromNumber: undefined }

// The scalar of a single literal.
function literalScalar(literal: SchemaAST.LiteralValue): Scalar {
  switch (typeof literal) {
    case "string":
      return scalar("string")
    case "boolean":
      return scalar("bool")
    case "bigint":
      return scalar("int64")
    default:
      return scalar(Wire.isInt32(literal) ? "int32" : "double")
  }
}

// A union of literals: an enum with `enumNumbers` or 32-bit integer members,
// and otherwise the scalar the literals share.
function literalValue(members: ReadonlyArray<SchemaAST.AST>, resolved: S.Resolved, where: string): Type {
  const literals = members.map((member) => (S.resolveEncoded(member).ast as SchemaAST.Literal).literal)
  const mapping = resolved.annotations[S.ENUM_KEY] as Readonly<Record<string, number>> | undefined
  if (mapping !== undefined) return mappedEnum(literals, mapping, where)
  if (literals.every((literal) => typeof literal === "number" && Wire.isInt32(literal))) return OWN_NUMBERS
  const kind = typeof literals[0]
  if (!literals.every((literal) => typeof literal === kind)) {
    throw layoutError(`${where} is a union of literals of different types; annotate it with Protobuf.enumNumbers`)
  }
  // Numbers that are not all 32-bit integers share `double`.
  return kind === "number" ? scalar("double") : literalScalar(literals[0])
}

// An enum whose values are mapped to numbers by `Protobuf.enumNumbers`. A
// number shared by several values decodes to the first of them.
function mappedEnum(values: ReadonlyArray<unknown>, mapping: Readonly<Record<string, number>>, where: string): Enum {
  const toNumber = new Map<unknown, number>()
  const fromNumber = new Map<number, unknown>()
  const names = new Set<string>()
  for (const value of values) {
    const name = String(value)
    if (names.has(name)) throw layoutError(`${where} has several enum values named ${name}`)
    names.add(name)
    const number = Object.hasOwn(mapping, name) ? mapping[name] : undefined
    if (number === undefined || !Wire.isInt32(number)) {
      throw layoutError(`${where} has no 32-bit enum number for ${name}`)
    }
    toNumber.set(value, number)
    if (!fromNumber.has(number)) fromNumber.set(number, value)
  }
  return { _tag: "Enum", wireType: Wire.WIRE_VARINT, toNumber, fromNumber }
}

function compileMapKey(resolved: S.Resolved, where: string): Scalar {
  const declared = (resolved.annotations[S.MAP_KEY_KEY] ?? resolved.annotations[S.SCALAR_KEY]) as
    | S.ScalarName
    | undefined
  switch (resolved.ast._tag) {
    case "String":
    case "TemplateLiteral":
      if (declared === undefined) return scalar("string")
      if (declared === "bool" || S.is64Bit(declared)) return scalar(declared)
      break
    case "Number": {
      const s = declared ?? "int32"
      if (s !== "bool" && s !== "string" && s !== "bytes") return scalar(s, S.is64Bit(s))
      break
    }
  }
  throw layoutError(`${where} has an unsupported map key; use String, Number, Int32 (and friends), or Protobuf.mapKey`)
}

// Options that do not apply to a field are rejected rather than ignored.
function checkOptions(annotation: S.FieldAnnotation, kind: "singular" | "repeated" | "map" | "case", where: string) {
  if (annotation.packed !== undefined && kind !== "repeated") {
    throw layoutError(`${where} is not a repeated field; only repeated fields can be packed`)
  }
  if (annotation.presence !== undefined && kind !== "singular") {
    throw layoutError(`${where} is not a singular field; only singular fields take presence "always"`)
  }
  if (annotation.encoding !== undefined && kind === "map") {
    throw layoutError(`${where} is a map; only messages can use the delimited encoding`)
  }
}

function checkDelimited(annotation: S.FieldAnnotation, type: Type, where: string): void {
  if (
    annotation.encoding === "delimited" && type._tag !== "Message" && type._tag !== "Converted" &&
    type._tag !== "Constant"
  ) {
    throw layoutError(`${where} is not a message; only messages can use the delimited encoding`)
  }
}

// The value of a unit schema: a literal, a unique symbol, or a nullish keyword.
function constantOf(ast: SchemaAST.AST): { readonly value: unknown } | undefined {
  switch (ast._tag) {
    case "Literal":
      return { value: ast.literal }
    case "UniqueSymbol":
      return { value: ast.symbol }
    case "Null":
      return { value: null }
    case "Undefined":
    case "Void":
      return { value: undefined }
    default:
      return undefined
  }
}

function withoutUndefined(ast: SchemaAST.AST): SchemaAST.AST {
  const resolved = S.resolveEncoded(ast).ast
  if (resolved._tag !== "Union") return ast
  const rest = resolved.types.filter((member) => S.resolveEncoded(member).ast._tag !== "Undefined")
  return rest.length === 1 ? rest[0] : ast
}

// An array whose elements all share one schema, written as a repeated field.
function isUniformArray(ast: SchemaAST.Arrays): boolean {
  if (ast.rest.length !== 1) return false
  const element = ast.rest[0]
  return ast.elements.every((item) =>
    item === element ||
    SchemaAST.getContextOwner(S.resolveEncoded(item).ast) === SchemaAST.getContextOwner(S.resolveEncoded(element).ast)
  )
}

function isGuarded(key: PropertyKey): boolean {
  return typeof key === "string" && key in Object.prototype
}

// What the codec reads from schemas: the protobuf annotations, the encoded side
// of a node, and the rewrite that prepares a schema for the wire layer.

import { memoizeIdempotent } from "../../Function.ts"
import * as Predicate from "../../Predicate.ts"
import * as Schema from "../../Schema.ts"
import * as SchemaAST from "../../SchemaAST.ts"
import * as SchemaTransformation from "../../SchemaTransformation.ts"

/** @internal */
export const FIELD_KEY = "~effect/encoding/Protobuf/field"
/** @internal */
export const SCALAR_KEY = "~effect/encoding/Protobuf/scalar"
/** @internal */
export const MAP_KEY_KEY = "~effect/encoding/Protobuf/mapKey"
/** @internal */
export const WRAPPER_KEY = "~effect/encoding/Protobuf/wrapper"
/** @internal */
export const ENUM_KEY = "~effect/encoding/Protobuf/enum"
/** @internal */
export const WKT_KEY = "~effect/encoding/Protobuf/wkt"
/** @internal */
export const UNKNOWN_KEY = "~effect/encoding/Protobuf/unknown"
const CASE_KEY = "~effect/encoding/Protobuf/case"

/** @internal */
export const WRAPPER_ANNOTATIONS = { [WRAPPER_KEY]: true }

/** @internal */
export const MAX_FIELD_NUMBER = 536_870_911 // 2 ** 29 - 1

/** @internal */
export interface FieldAnnotation {
  readonly number: number
  readonly packed: boolean | undefined
  readonly presence: "always" | undefined
  readonly encoding: "delimited" | undefined
}

/** @internal */
export type ScalarName =
  | "double"
  | "float"
  | "int32"
  | "uint32"
  | "sint32"
  | "fixed32"
  | "sfixed32"
  | "int64"
  | "uint64"
  | "sint64"
  | "fixed64"
  | "sfixed64"
  | "bool"
  | "string"
  | "bytes"

/** @internal */
export function isUnsigned(scalar: ScalarName): boolean {
  return scalar === "uint32" || scalar === "fixed32" || scalar === "uint64" || scalar === "fixed64"
}

/** @internal */
export function is64Bit(scalar: ScalarName): boolean {
  return scalar === "int64" || scalar === "uint64" || scalar === "sint64" || scalar === "fixed64" ||
    scalar === "sfixed64"
}

// -----------------------------------------------------------------------------
// reading annotations
// -----------------------------------------------------------------------------

/**
 * The encoded side of a node, reached through its encoding chain and
 * suspensions.
 *
 * @internal
 */
export interface Resolved {
  readonly ast: SchemaAST.AST
  // The first identifier on the encoding chain.
  readonly identifier: string | undefined
  // The protobuf annotations of the encoding chain; the outermost wins.
  readonly annotations: Readonly<Record<string, unknown>>
}

const RESOLVED_KEYS = [SCALAR_KEY, MAP_KEY_KEY, WRAPPER_KEY, ENUM_KEY, WKT_KEY, UNKNOWN_KEY]

/** @internal */
export function resolveEncoded(ast: SchemaAST.AST): Resolved {
  let identifier: string | undefined
  let annotations: Record<string, unknown> | undefined
  while (true) {
    if (identifier === undefined && typeof ast.annotations?.identifier === "string") {
      identifier = ast.annotations.identifier
    }
    for (const key of RESOLVED_KEYS) {
      if (annotations?.[key] !== undefined) continue
      const value = getAnnotation(ast, key)
      if (value !== undefined) (annotations ??= {})[key] = value
    }
    if (ast.encoding !== undefined) {
      ast = ast.encoding[ast.encoding.length - 1].to
    } else if (ast._tag === "Suspend") {
      ast = ast.thunk()
    } else {
      return { ast, identifier, annotations: annotations ?? {} }
    }
  }
}

// `annotate` on a checked schema lands on its last check, so annotations are
// looked up on the node and then on its checks.
function getAnnotation(ast: SchemaAST.AST, key: string): unknown {
  const own = ast.annotations?.[key]
  if (own !== undefined || ast.checks === undefined) return own
  for (let i = ast.checks.length - 1; i >= 0; i--) {
    const found = getCheckAnnotation(ast.checks[i], key)
    if (found !== undefined) return found
  }
  return undefined
}

function getCheckAnnotation(check: SchemaAST.Check<any>, key: string): unknown {
  const own = check.annotations?.[key]
  if (own !== undefined || check._tag !== "FilterGroup") return own
  for (const inner of check.checks) {
    const found = getCheckAnnotation(inner, key)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * The field number of a property or oneof member. Key annotations live on the
 * outer node, or on a link of its encoding chain.
 *
 * @internal
 */
export function getFieldAnnotation(ast: SchemaAST.AST): FieldAnnotation | undefined {
  while (true) {
    const found = ast.context?.annotations?.[FIELD_KEY]
    if (found !== undefined) return found as FieldAnnotation
    if (ast.encoding === undefined) return undefined
    ast = ast.encoding[ast.encoding.length - 1].to
  }
}

/** @internal */
export function representationId(ast: SchemaAST.AST): string | undefined {
  const representation = ast.annotations?.representation
  return Predicate.isObject(representation) && typeof representation.id === "string" ? representation.id : undefined
}

/** @internal */
export function isNullish(ast: SchemaAST.AST): boolean {
  return ast._tag === "Null" || ast._tag === "Undefined" || ast._tag === "Void"
}

/**
 * Literals that share one field, rather than oneof cases, which are numbered.
 *
 * @internal
 */
export function isLiteralUnion(members: ReadonlyArray<SchemaAST.AST>): boolean {
  return members.every((member) =>
    resolveEncoded(member).ast._tag === "Literal" && getFieldAnnotation(member) === undefined
  )
}

/**
 * The members of a union, with unnumbered nested unions expanded. Unions of
 * literals stay whole, since their annotations decide the enum numbers.
 *
 * @internal
 */
export function flattenUnion(ast: SchemaAST.Union): Array<SchemaAST.AST> {
  const out: Array<SchemaAST.AST> = []
  for (const member of ast.types) {
    const inner = resolveEncoded(member).ast
    if (inner._tag === "Union" && getFieldAnnotation(member) === undefined && !isLiteralUnion(inner.types)) {
      out.push(...flattenUnion(inner))
    } else {
      out.push(member)
    }
  }
  return out
}

/**
 * A union compiles to a oneof unless its members are literals, or a single
 * member made optional by nullish ones.
 *
 * @internal
 */
export function isOneof(ast: SchemaAST.Union): boolean {
  const members = flattenUnion(ast)
  const values = members.filter((member) => !isNullish(resolveEncoded(member).ast))
  if (values.length === 0 || (values.length === 1 && values.length < members.length)) return false
  return !isLiteralUnion(values)
}

/**
 * The property of a tagged struct that holds the value of its oneof case: the
 * struct's only property that is not an unnumbered literal.
 *
 * @internal
 */
export interface StructCase {
  readonly key: string
  readonly type: SchemaAST.AST
  readonly annotation: FieldAnnotation
  // The unnumbered literals, restored on decode.
  readonly literals: ReadonlyArray<readonly [string, unknown]>
}

/** @internal */
export function getStructCase(ast: SchemaAST.AST): StructCase | undefined {
  if (ast._tag !== "Objects" || ast.indexSignatures.length > 0) return undefined
  const literals: Array<readonly [string, unknown]> = []
  const values: Array<SchemaAST.PropertySignature> = []
  for (const ps of ast.propertySignatures) {
    const inner = resolveEncoded(ps.type).ast
    if (inner._tag === "Literal" && typeof ps.name === "string" && getFieldAnnotation(ps.type) === undefined) {
      literals.push([ps.name, inner.literal])
    } else {
      values.push(ps)
    }
  }
  if (values.length !== 1 || typeof values[0].name !== "string") return undefined
  const annotation = getFieldAnnotation(values[0].type)
  return annotation === undefined ? undefined : { key: values[0].name, type: values[0].type, annotation, literals }
}

// -----------------------------------------------------------------------------
// the protobuf AST
// -----------------------------------------------------------------------------

// Declarations with a native protobuf mapping. Any other declaration is
// replaced by its JSON encoding, or its codec.
const NATIVE_DECLARATIONS = new Set([
  "effect/schema/Date",
  "effect/schema/DateTimeUtc",
  "effect/schema/Duration",
  "effect/schema/Uint8Array",
  "effect/schema/Option",
  "effect/schema/Json",
  "effect/schema/MutableJson"
])

/**
 * Rewrites a schema for the wire layer: declarations without a protobuf
 * mapping are replaced by their JSON encoding, and the members of each oneof
 * are tagged with their case number.
 *
 * @internal
 */
export const toProtobufAST = SchemaAST.applyToSelfOrLastLinkEncodingIdempotent((ast) => {
  const out = rewrite(ast)
  const context = ast.context
  if (out === ast || context === undefined) return out
  return SchemaAST.replaceContextLastLink(
    out,
    new SchemaAST.Context(context.isOptional, context.isMutable, undefined, context.annotations)
  )
})

function rewrite(ast: SchemaAST.AST): SchemaAST.AST {
  switch (ast._tag) {
    case "Declaration": {
      const id = representationId(ast)
      if (id !== undefined && NATIVE_DECLARATIONS.has(id)) return ast.recur(toProtobufAST)
      const getJson = ast.annotations?.toCodecJson
      const getCodec = ast.annotations?.toCodec
      if (!Predicate.isFunction(getJson) && !Predicate.isFunction(getCodec)) return ast
      const typeParameters = ast.typeParameters.map((tp) => Schema.make<Schema.Constraint>(SchemaAST.toEncoded(tp)))
      const link = (Predicate.isFunction(getJson) ? getJson(typeParameters) : undefined) ??
        (Predicate.isFunction(getCodec) ? getCodec(typeParameters) : undefined)
      return link === undefined ? ast : SchemaAST.replaceEncoding(ast, [SchemaAST.mapLink(link, toProtobufAST)])
    }
    case "Union": {
      const union = ast.recur(toProtobufAST)
      return isOneof(union) ? tagCases(union) : union
    }
    case "Arrays":
    case "Objects":
    case "Suspend":
      return ast.recur(toProtobufAST)
    default:
      return ast
  }
}

/**
 * The encoded value of a oneof case, tagged with its number. Members of a
 * oneof can share an encoded form, such as a `FiniteFromString` and a `String`
 * case, so the tag makes `Schema.Union` encode and decode the member that the
 * wire names, rather than the first member that accepts the value.
 *
 * @internal
 */
export class CaseValue {
  readonly number: number
  readonly value: unknown
  constructor(number: number, value: unknown) {
    this.number = number
    this.value = value
  }
}

/**
 * A tagged oneof member: the case number, and the member before tagging.
 *
 * @internal
 */
export interface TaggedCase {
  readonly number: number
  readonly member: SchemaAST.AST
}

/**
 * The case that a oneof member was tagged with, or `undefined` for a member
 * that is not a case.
 *
 * @internal
 */
export function getTaggedCase(member: SchemaAST.AST): TaggedCase | undefined {
  return resolveEncoded(member).ast.annotations?.[CASE_KEY] as TaggedCase | undefined
}

// Tags the members of a oneof, including those of the unnumbered unions that
// are flattened into it. Members that are not cases are left for the layout to
// reject.
const tagCases = memoizeIdempotent((ast: SchemaAST.Union): SchemaAST.Union => ast.recur(tagMember))

function tagMember(member: SchemaAST.AST): SchemaAST.AST {
  if (getTaggedCase(member) !== undefined) return member
  const resolved = resolveEncoded(member).ast
  if (isNullish(resolved)) return member
  const annotation = getFieldAnnotation(member)
  if (annotation !== undefined) return tagCase(member, annotation.number)
  if (resolved._tag === "Union") return isLiteralUnion(resolved.types) ? member : tagFlattened(member)
  const structCase = getStructCase(resolved)
  return structCase === undefined ? member : tagCase(member, structCase.annotation.number)
}

// Tags the members of an unnumbered nested union, wherever on the encoding
// chain `flattenUnion` finds it.
function tagFlattened(ast: SchemaAST.AST): SchemaAST.AST {
  if (ast.encoding !== undefined) return SchemaAST.applyToLastLink(tagFlattened)(ast)
  switch (ast._tag) {
    case "Suspend":
      return ast.recur(tagFlattened)
    case "Union":
      return tagCases(ast)
    default:
      return ast
  }
}

function tagCase(member: SchemaAST.AST, number: number): SchemaAST.AST {
  const tagged: TaggedCase = { number, member }
  const declaration = Schema.declare((u): u is CaseValue => u instanceof CaseValue && u.number === number, {
    expected: `oneof case ${number}`,
    [CASE_KEY]: tagged
  }).ast
  return SchemaAST.decodeTo(
    declaration,
    member,
    SchemaTransformation.transform<unknown, CaseValue>({
      decode: (value) => value.value,
      encode: (value) => new CaseValue(number, value)
    })
  )
}

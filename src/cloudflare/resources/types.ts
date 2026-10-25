

// A resource kind was requested that the installer does not support. Fail
// closed: never fall through to a generic request.
export class UnsupportedResourceError extends Error {
  readonly kind = "unsupported-resource";
  constructor(resourceKind: string) {
    super(`Unsupported Cloudflare resource kind "${resourceKind}"`);
  }
}

// A declared resource cannot be reconciled without risking an overwrite. Fail
// closed rather than recreate or replace an existing resource.
export class ResourceConflictError extends Error {
  readonly kind = "conflict";
  constructor(message: string) {
    super(message);
  }
}

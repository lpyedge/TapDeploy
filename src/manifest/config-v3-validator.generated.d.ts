// Types for the generated, precompiled Config V3 schema validator.
export interface GeneratedSchemaValidator {
  (data: unknown): boolean;
  errors?: Array<{ instancePath: string; message?: string }> | null;
}
declare const validate: GeneratedSchemaValidator;
export default validate;

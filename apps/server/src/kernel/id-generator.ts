import { randomUUID } from "node:crypto";

export interface IdGenerator {
  generate(): string;
}

export class UuidIdGenerator implements IdGenerator {
  generate(): string {
    return randomUUID();
  }
}

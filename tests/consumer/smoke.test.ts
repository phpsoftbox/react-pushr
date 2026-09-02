import { describe, expect, it } from 'vitest';
import { PushrClient, createPushrService } from '@phpsoftbox/pushr';
import { usePushrEvent } from '@phpsoftbox/pushr/react';

describe('published Pushr package', () => {
  it('loads both exported entrypoints through the consumer resolver', () => {
    expect(PushrClient).toBeTypeOf('function');
    expect(createPushrService).toBeTypeOf('function');
    expect(usePushrEvent).toBeTypeOf('function');
  });
});

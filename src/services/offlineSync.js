
const QUEUE_KEY = '3dish_offline_queue';
const RETRY_DELAYS = [3000, 8000, 20000];

const readQueue = () => {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  } catch {
    return [];
  }
};

const writeQueue = (queue) => {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch (error) {
    console.error('Failed to persist offline queue:', error);
  }
};

function validateCart(cart, liveDishes) {
  const warnings = [];
  const updatedCart = [];

  cart.forEach((item) => {
    const dish = liveDishes.find(
      (d) => d.id === (item.originalId || item.id)
    );

    if (!dish) {
      warnings.push({
        type: 'removed',
        id: item.itemId ?? item.id,
        name: item.name,
      });
      return;
    }

    const isUnavailable =
      dish.tags?.includes('sold_out') ||
      dish.available === false ||
      dish.macros?.available === false;

    if (isUnavailable) {
      warnings.push({
        type: 'unavailable',
        id: item.id,
        name: item.name,
      });
      return;
    }

    const selectedVariant = item.selectedVariant
      ? dish.variants?.find(
          (v) => v.name === item.selectedVariant.name
        )
      : null;

    // A missing selected variant should not silently use
    // the base dish price.
    if (item.selectedVariant && !selectedVariant) {
      warnings.push({
        type: 'variant_removed',
        id: item.id,
        name: item.name,
      });
      return;
    }

    const livePrice = Number(
      item.selectedVariant
        ? selectedVariant.price
        : dish.price
    );

    const oldPrice = Number(item.price);

    if (
      !Number.isFinite(livePrice) ||
      !Number.isFinite(oldPrice) ||
      livePrice < 0
    ) {
      warnings.push({
        type: 'invalid_price',
        id: item.id,
        name: item.name,
      });
      return;
    }

    if (Math.abs(livePrice - oldPrice) > 0.01) {
      warnings.push({
        type: 'price_changed',
        id: item.id,
        name: item.name,
        oldPrice,
        newPrice: livePrice,
      });

      updatedCart.push({ ...item, price: livePrice });
    } else {
      updatedCart.push(item);
    }
  });

  const hasBlockingIssue = warnings.some(
    (warning) =>
      warning.type === 'removed' ||
      warning.type === 'unavailable' ||
      warning.type === 'variant_removed' ||
      warning.type === 'invalid_price'
  );

  return {
    valid: !hasBlockingIssue,
    warnings,
    updatedCart,
  };
}

function enqueueOrder(idempotencyKey, orderPayload) {
  if (!idempotencyKey) {
    throw new Error('An idempotency key is required.');
  }

  const queue = readQueue();

  if (
    queue.some((op) => op.idempotencyKey === idempotencyKey)
  ) {
    return;
  }

  queue.push({
    idempotencyKey,
    orderPayload,
    retries: 0,
    queuedAt: Date.now(),
  });

  writeQueue(queue);
}

async function flushQueue(
  supabase,
  { onSuccess, onPermanentFailure } = {}
) {
  const queue = readQueue();

  if (!queue.length) return 0;

  const remaining = [];

  for (const op of queue) {
    try {
      const { data: existing, error: lookupError } =
        await supabase
          .from('orders')
          .select('id')
          .filter(
            'metadata->>idempotencyKey',
            'eq',
            op.idempotencyKey
          )
          .maybeSingle();

      if (lookupError) throw lookupError;

      if (existing) {
        onSuccess?.(op, 'already_synced');
        continue;
      }

      const payload = {
        ...op.orderPayload,
        metadata: {
          ...op.orderPayload.metadata,
          idempotencyKey: op.idempotencyKey,
        },
      };

      const { error: insertError } = await supabase
        .from('orders')
        .insert([payload]);

      if (insertError) throw insertError;

      onSuccess?.(op, 'synced');
    } catch (error) {
      if (op.retries < RETRY_DELAYS.length) {
        const delay = RETRY_DELAYS[op.retries];

        remaining.push({
          ...op,
          retries: op.retries + 1,
          nextRetryAt: Date.now() + delay,
          lastError: error.message,
        });
      } else {
        onPermanentFailure?.(op, error);
      }
    }
  }

  // Preserve operations added while this sync was running.
  const processedKeys = new Set(
    queue.map((op) => op.idempotencyKey)
  );

  const latestQueue = readQueue();
  const newlyQueued = latestQueue.filter(
    (op) => !processedKeys.has(op.idempotencyKey)
  );

  writeQueue([...remaining, ...newlyQueued]);

  return remaining.length + newlyQueued.length;
}

const getQueueLength = () => readQueue().length;

function setupConnectivityListener(supabase, callbacks) {
  const flush = () => flushQueue(supabase, callbacks);

  window.addEventListener('online', flush);

  if (navigator.onLine) {
    flush();
  }

  return () => window.removeEventListener('online', flush);
}

export {
  validateCart,
  enqueueOrder,
  flushQueue,
  getQueueLength,
  setupConnectivityListener,
};

// In-memory mock MongoDB client (No external database or URI required)
class MockDb {
  async command(_cmd: Record<string, unknown>) {
    return { ok: 1 };
  }

  collection(_name: string) {
    const memoryStore: Record<string, unknown>[] = [];
    return {
      find: () => ({
        toArray: async () => memoryStore,
        limit: () => ({ toArray: async () => memoryStore })
      }),
      findOne: async (query?: Record<string, unknown>) => {
        return memoryStore[0] || null;
      },
      insertOne: async (doc: Record<string, unknown>) => {
        const item = { _id: "mock_" + Date.now(), ...doc };
        memoryStore.push(item);
        return { insertedId: item._id, acknowledged: true };
      },
      updateOne: async () => ({ modifiedCount: 1, acknowledged: true }),
      deleteOne: async () => ({ deletedCount: 1, acknowledged: true })
    };
  }
}

class MockMongoClient {
  async connect() {
    return this;
  }

  db(_name?: string) {
    return new MockDb();
  }

  async close() {}
}

const client = new MockMongoClient() as any;

export default client;

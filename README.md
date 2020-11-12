# firestore-batcher

The easier way to do batched write operations for Cloud Firestore.

```typescript
import * as firebase from 'firestore-admin'
import firestoreBatcher, { deleteOperation } from 'firestore-batcher'

const app = firebase.initializeApp()
const db = firebase.firestore()

const batcher = firestoreBatcher(db)

async function bulkDelete() {
    const finishedTodosQuery = db
        .collection('todos')
        .where('finished', '==', true)

    await batcher.all(finishedTodosQuery, todoRef => deleteOperation(todoRef))
}

bulkDelete()
```

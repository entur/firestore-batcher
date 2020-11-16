import { firestore } from 'firebase-admin'

enum OperationName {
    CREATE = 'create',
    DELETE = 'delete',
    SET = 'set',
    UPDATE = 'update',
}

interface CreateOperation<T> {
    name: OperationName.CREATE
    documentRef: firestore.DocumentReference<T>
    data: T
}

export function createOperation<T>(
    documentRef: firestore.DocumentReference<T>,
    data: T,
): CreateOperation<T> {
    return {
        name: OperationName.CREATE,
        documentRef,
        data,
    }
}

interface DeleteOperation<T> {
    name: OperationName.DELETE
    documentRef: firestore.DocumentReference<T>
    precondition?: FirebaseFirestore.Precondition
}

export function deleteOperation<T>(
    documentRef: firestore.DocumentReference<T>,
    precondition?: FirebaseFirestore.Precondition,
): DeleteOperation<T> {
    return {
        name: OperationName.DELETE,
        documentRef,
        precondition,
    }
}

interface SetOperation<T extends FirebaseFirestore.UpdateData> {
    name: OperationName.SET
    documentRef: firestore.DocumentReference<T>
    data: T
}

export function setOperation<T>(
    documentRef: firestore.DocumentReference<T>,
    data: T,
): SetOperation<T> {
    return {
        name: OperationName.SET,
        documentRef,
        data,
    }
}

interface UpdateOperation<T> {
    name: OperationName.UPDATE
    documentRef: firestore.DocumentReference<T>
    data: FirebaseFirestore.UpdateData
    precondition?: FirebaseFirestore.Precondition
}

export function updateOperation<T>(
    documentRef: firestore.DocumentReference<T>,
    data: T,
    precondition?: FirebaseFirestore.Precondition,
): UpdateOperation<T> {
    return {
        name: OperationName.UPDATE,
        documentRef,
        data,
        precondition,
    }
}

type Operation<T> =
    | CreateOperation<T>
    | DeleteOperation<T>
    | SetOperation<T>
    | UpdateOperation<T>

interface BatcherStats {
    batchSize: number
    operationsProcessed: number
    operationsQueued: number
}

interface BatcherOptions {
    onBatchCommited?: (stats: BatcherStats) => void
}

interface Batcher {
    add: <T>(operation: Operation<T>) => void
    all: (
        query: FirebaseFirestore.Query<FirebaseFirestore.DocumentData>,
        operationBuilder: <T>(
            doc: firestore.DocumentReference<T>,
        ) => Operation<T>,
    ) => Promise<void>
    commit: () => Promise<void>
    stats: () => BatcherStats
}

function addOperationToBatch<T>(
    batch: firestore.WriteBatch,
    operation: Operation<T>,
): void {
    const { documentRef } = operation
    switch (operation.name) {
        case OperationName.CREATE:
            batch.create(documentRef, operation.data)
            break
        case OperationName.DELETE:
            batch.delete(documentRef, operation.precondition)
            break
        case OperationName.SET:
            batch.set(documentRef, operation.data)
            break
        case OperationName.UPDATE: {
            if (operation.precondition) {
                batch.update(
                    documentRef,
                    operation.data,
                    operation.precondition,
                )
            } else {
                batch.update(documentRef, operation.data)
            }
            break
        }
    }
}

function safeRecursiveAsyncCallback<T>(callback: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) =>
        process.nextTick(() => callback().then(resolve).catch(reject)),
    )
}

export default function batcher(
    db: firestore.Firestore,
    options?: BatcherOptions,
): Batcher {
    let operationsProcessed = 0
    let batchSize = 500

    let operations: Operation<any>[] = []

    const stats = () => ({
        batchSize,
        operationsProcessed,
        operationsQueued: operations.length,
    })

    const add = <T>(operation: Operation<T>): void => {
        operations.push(operation)
    }

    const commit = async (): Promise<void> => {
        try {
            if (!operations.length) {
                return
            }

            const batch = db.batch()

            const opsToCommit = operations.slice(0, batchSize)

            opsToCommit.forEach((operation) => {
                addOperationToBatch(batch, operation)
            })

            await batch.commit()
            operationsProcessed += opsToCommit.length
            operations = operations.slice(opsToCommit.length)

            if (options?.onBatchCommited) {
                options.onBatchCommited(stats())
            }

            batchSize = Math.min(Math.floor(batchSize * 1.5), 500)
            await safeRecursiveAsyncCallback(commit)
        } catch (error) {
            if (
                error.code === 3 &&
                error.details ===
                    'Transaction too big. Decrease transaction size.'
            ) {
                batchSize = Math.floor(batchSize / 2)
                return safeRecursiveAsyncCallback(commit)
            }
            throw error
        }
    }

    const all = async (
        query: FirebaseFirestore.Query<FirebaseFirestore.DocumentData>,
        operationBuilder: <T>(
            doc: firestore.DocumentReference<T>,
        ) => Operation<T>,
    ): Promise<void> => {
        const limitedQuery = query.limit(batchSize)
        const result = await limitedQuery.get()

        if (result.size === 0) {
            return
        }

        result.docs.forEach((doc) => add(operationBuilder(doc.ref)))
        await commit()
        await safeRecursiveAsyncCallback(() => all(query, operationBuilder))
    }

    return {
        add,
        all,
        commit,
        stats,
    }
}

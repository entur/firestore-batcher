import {
    DocumentReference,
    Firestore,
    UpdateData,
    WithFieldValue,
    WriteBatch,
} from 'firebase-admin/firestore'

enum OperationName {
    CREATE = 'create',
    DELETE = 'delete',
    SET = 'set',
    UPDATE = 'update',
}

interface CreateOperation<T> {
    name: OperationName.CREATE
    documentRef: DocumentReference<T>
    data: T
}

export function createOperation<T>(
    documentRef: DocumentReference<T>,
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
    documentRef: DocumentReference<T>
    precondition?: FirebaseFirestore.Precondition
}

export function deleteOperation<T>(
    documentRef: DocumentReference<T>,
    precondition?: FirebaseFirestore.Precondition,
): DeleteOperation<T> {
    return {
        name: OperationName.DELETE,
        documentRef,
        precondition,
    }
}

interface SetOperation<T> {
    name: OperationName.SET
    documentRef: DocumentReference<T>
    data: WithFieldValue<T>
}

export function setOperation<T>(
    documentRef: DocumentReference<T>,
    data: WithFieldValue<T>,
): SetOperation<T> {
    return {
        name: OperationName.SET,
        documentRef,
        data,
    }
}

interface UpdateOperation<T> {
    name: OperationName.UPDATE
    documentRef: DocumentReference<T>
    data: UpdateData<T>
    precondition?: FirebaseFirestore.Precondition
}

export function updateOperation<T>(
    documentRef: DocumentReference<T>,
    data: UpdateData<T>,
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
        operationBuilder: <T>(doc: DocumentReference<T>) => Operation<T>,
    ) => Promise<void>
    commit: () => Promise<void>
    stats: () => BatcherStats
}

function addOperationToBatch<T>(
    batch: WriteBatch,
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
    db: Firestore,
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
        } catch (error: any) {
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
        operationBuilder: <T>(doc: DocumentReference<T>) => Operation<T>,
    ): Promise<void> => {
        const limitedQuery = query.limit(batchSize)
        let result = await limitedQuery.get()

        while (result.size > 0) {
            result.docs.forEach((doc) => add(operationBuilder(doc.ref)))
            await commit()
            result = await limitedQuery.get()
        }
    }

    return {
        add,
        all,
        commit,
        stats,
    }
}

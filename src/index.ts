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

interface Batcher {
    add: <T>(operation: Operation<T>) => void
    all: (
        query: FirebaseFirestore.Query<FirebaseFirestore.DocumentData>,
        operationBuilder: <T>(
            doc: firestore.DocumentReference<T>,
        ) => Operation<T>,
    ) => Promise<void>
    commit: () => Promise<void>
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
            batch.set(documentRef, (operation as SetOperation<T>).data)
            break
        case OperationName.UPDATE:
            batch.update(documentRef, operation.data, operation.precondition)
            break
    }
}

function safeRecursiveAsyncCallback<T>(callback: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) =>
        process.nextTick(() => callback().then(resolve).catch(reject)),
    )
}

export default function batcher(db: firestore.Firestore): Batcher {
    let batch = db.batch()
    let numberOfOperationsCurrentBatch = 0
    let numberOfOperationsProcessed = 0
    let batchSize = 500

    let operations: Operation<any>[] = []

    const add = <T>(operation: Operation<T>): void => {
        operations.push(operation)
    }

    const commit = async (): Promise<void> => {
        try {
            // recursion base case
            if (!operations.length) {
                return
            }

            operations.slice(0, batchSize).forEach((operation) => {
                addOperationToBatch(batch, operation)
            })

            await batch.commit()
            batchSize = Math.min(batchSize * 1.5, 500)
            numberOfOperationsProcessed += operations.length

            console.log(
                `Batch committed. Batch size: ${batchSize}. Total processed: ${numberOfOperationsProcessed}`,
            )

            numberOfOperationsCurrentBatch = 0
            operations = operations.slice(batchSize)
            batch = db.batch()
            await safeRecursiveAsyncCallback(commit)
        } catch (error) {
            // Reduce batch size if error "Transaction too big"
            if (error.code === 3) {
                batchSize = Math.floor(batchSize / 2)
                console.log('Decreasing batch size to', batchSize)
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
    }
}

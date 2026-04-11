import { initializeApp, type FirebaseApp } from 'firebase/app'
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type Auth,
  type User,
} from 'firebase/auth'
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Firestore,
} from 'firebase/firestore'

export type AuthUser = {
  displayName: string
  email: string
  photoURL: string
  uid: string
}

export type CloudTierListSummary = {
  createdAtMillis: number
  favorite: boolean
  id: string
  itemCount: number
  listContext: string
  tierCount: number
  title: string
  updatedAtMillis: number
}

export type CloudTierListSnapshot = Record<string, unknown>

export type CloudTierListSaveInput = {
  itemCount: number
  listContext: string
  snapshot: CloudTierListSnapshot
  tierCount: number
  title: string
}

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
}

const firebaseConfigured = Boolean(
  firebaseConfig.apiKey &&
    firebaseConfig.appId &&
    firebaseConfig.authDomain &&
    firebaseConfig.projectId,
)

let app: FirebaseApp | null = null
let auth: Auth | null = null
let db: Firestore | null = null

export function isFirebaseConfigured() {
  return firebaseConfigured
}

export function subscribeToAuth(callback: (user: AuthUser | null) => void) {
  if (!firebaseConfigured) {
    callback(null)
    return () => {}
  }

  const { auth: firebaseAuth } = getFirebaseServices()

  return onAuthStateChanged(firebaseAuth, (user) => {
    callback(user ? toAuthUser(user) : null)
  })
}

export async function signInWithGoogle() {
  const { auth: firebaseAuth } = getFirebaseServices()
  const provider = new GoogleAuthProvider()
  provider.setCustomParameters({ prompt: 'select_account' })
  const result = await signInWithPopup(firebaseAuth, provider)
  return toAuthUser(result.user)
}

export async function signOutOfGoogle() {
  const { auth: firebaseAuth } = getFirebaseServices()
  await signOut(firebaseAuth)
}

export async function listUserTierLists(userId: string) {
  const { db: firestore } = getFirebaseServices()
  const listsQuery = query(
    collection(firestore, 'users', userId, 'tierLists'),
    orderBy('updatedAt', 'desc'),
  )
  const snapshot = await getDocs(listsQuery)

  return snapshot.docs.map((entry) => toCloudTierListSummary(entry.id, entry.data()))
}

export async function saveUserTierList(userId: string, listId: string | null, input: CloudTierListSaveInput) {
  const { db: firestore } = getFirebaseServices()
  const listRef = listId
    ? doc(firestore, 'users', userId, 'tierLists', listId)
    : doc(collection(firestore, 'users', userId, 'tierLists'))
  const now = Date.now()

  await setDoc(
    listRef,
    {
      itemCount: input.itemCount,
      listContext: input.listContext,
      snapshot: input.snapshot,
      tierCount: input.tierCount,
      title: input.title || 'Untitled tier list',
      updatedAt: serverTimestamp(),
      updatedAtMillis: now,
      ...(!listId
        ? {
            createdAt: serverTimestamp(),
            createdAtMillis: now,
            favorite: false,
          }
        : {}),
    },
    { merge: true },
  )

  return listRef.id
}

export async function getUserTierListSnapshot(userId: string, listId: string) {
  const { db: firestore } = getFirebaseServices()
  const snapshot = await getDoc(doc(firestore, 'users', userId, 'tierLists', listId))

  if (!snapshot.exists()) {
    throw new Error('That saved tier list no longer exists.')
  }

  const data = snapshot.data()

  if (!data.snapshot || typeof data.snapshot !== 'object') {
    throw new Error('That saved tier list does not contain a readable snapshot.')
  }

  return data.snapshot as CloudTierListSnapshot
}

export async function setUserTierListFavorite(userId: string, listId: string, favorite: boolean) {
  const { db: firestore } = getFirebaseServices()
  await updateDoc(doc(firestore, 'users', userId, 'tierLists', listId), {
    favorite,
    updatedAt: serverTimestamp(),
    updatedAtMillis: Date.now(),
  })
}

export async function deleteUserTierList(userId: string, listId: string) {
  const { db: firestore } = getFirebaseServices()
  await deleteDoc(doc(firestore, 'users', userId, 'tierLists', listId))
}

function getFirebaseServices() {
  if (!firebaseConfigured) {
    throw new Error('Firebase is not configured yet. Add the VITE_FIREBASE_* environment variables to enable Google sign-in.')
  }

  if (!app) {
    app = initializeApp(firebaseConfig)
    auth = getAuth(app)
    db = getFirestore(app)
  }

  return {
    auth: auth as Auth,
    db: db as Firestore,
  }
}

function toAuthUser(user: User): AuthUser {
  return {
    displayName: user.displayName || 'Google user',
    email: user.email || '',
    photoURL: user.photoURL || '',
    uid: user.uid,
  }
}

function toCloudTierListSummary(id: string, data: Record<string, unknown>): CloudTierListSummary {
  return {
    createdAtMillis: getMillis(data.createdAtMillis ?? data.createdAt),
    favorite: Boolean(data.favorite),
    id,
    itemCount: Number(data.itemCount || 0),
    listContext: typeof data.listContext === 'string' ? data.listContext : '',
    tierCount: Number(data.tierCount || 0),
    title: typeof data.title === 'string' ? data.title : 'Untitled tier list',
    updatedAtMillis: getMillis(data.updatedAtMillis ?? data.updatedAt),
  }
}

function getMillis(value: unknown) {
  if (typeof value === 'number') return value
  if (value instanceof Date) return value.getTime()
  if (value && typeof value === 'object' && 'toMillis' in value && typeof value.toMillis === 'function') {
    return value.toMillis()
  }
  return 0
}

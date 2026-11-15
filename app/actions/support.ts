'use server'

import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { dispute, disputeMessage, parent, student, supportTicket, supportTicketReply, user } from '@/lib/db/schema'
import { and, desc, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { randomUUID } from 'crypto'

function requireText(value: string, label: string, maxLength: number) {
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${label} is required and must be no more than ${maxLength} characters.`)
  }
  return normalized
}

function createTicketNumber(prefix: 'SUP' | 'DIS') {
  return `${prefix}-${Date.now()}-${randomUUID().slice(0, 6).toUpperCase()}`
}

async function isDisputeInAdministratorSchool(disputeRecord: typeof dispute.$inferSelect, administratorId: string) {
  const [raiser, administrator, relatedStudent] = await Promise.all([
    db.query.user.findFirst({ where: eq(user.id, disputeRecord.raisedById) }),
    db.query.user.findFirst({ where: eq(user.id, administratorId) }),
    disputeRecord.relatedStudentId
      ? db.query.student.findFirst({ where: eq(student.id, disputeRecord.relatedStudentId) })
      : Promise.resolve(null),
  ])
  const disputeSchoolId = relatedStudent?.schoolId || raiser?.schoolId
  return Boolean(disputeSchoolId && disputeSchoolId === administrator?.schoolId)
}

export async function createDispute(data: {
  title: string
  category: string
  priority: string
  description: string
  relatedStudentId?: string
  relatedPaymentId?: string
}) {
  const session = await auth.getSession()
  if (!session?.user) throw new Error('Sign in before raising a dispute.')
  const title = requireText(data.title, 'Dispute title', 160)
  const description = requireText(data.description, 'Dispute description', 5000)
  const role = session.user.role.toUpperCase()
  let relatedStudentId: string | null = null

  if (data.relatedStudentId) {
    const relatedStudent = await db.query.student.findFirst({
      where: eq(student.id, data.relatedStudentId),
    })
    if (!relatedStudent) throw new Error('The selected student was not found.')
    if (['STUDENT', 'PUPIL'].includes(role) && relatedStudent.userId !== session.user.id) {
      throw new Error('You can only raise a dispute for your own student account.')
    }
    if (role === 'PARENT') {
      const parentProfile = await db.query.parent.findFirst({
        where: eq(parent.userId, session.user.id),
      })
      if (!parentProfile || relatedStudent.parentId !== parentProfile.id) {
        throw new Error('You can only raise a dispute for a linked child.')
      }
    }
    relatedStudentId = relatedStudent.id
  }

  const [created] = await db.insert(dispute).values({
    id: randomUUID(),
    ticketNumber: createTicketNumber('DIS'),
    title,
    category: requireText(data.category, 'Category', 80),
    priority: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'].includes(data.priority.toUpperCase())
      ? data.priority.toUpperCase()
      : 'MEDIUM',
    description,
    raisedById: session.user.id,
    relatedStudentId,
    relatedPaymentId: data.relatedPaymentId || null,
    status: 'OPEN',
  }).returning()

  revalidatePath('/dashboard/admin/communication/disputes')
  revalidatePath('/dashboard/parent/communication/disputes')
  return created
}

export async function addDisputeMessage(disputeId: string, messageContent: string, isInternal = false) {
  const session = await auth.getSession()
  if (!session?.user) throw new Error('Sign in before replying to a dispute.')
  const message = requireText(messageContent, 'Message', 5000)
  const currentDispute = await db.query.dispute.findFirst({
    where: eq(dispute.id, disputeId),
  })
  if (!currentDispute) throw new Error('Dispute not found.')

  const role = session.user.role.toUpperCase()
  const isOwner = currentDispute.raisedById === session.user.id
  const isSchoolAdmin = ['ADMIN', 'SCHOOL_ADMIN'].includes(role)
  const canManageSchoolDispute = isSchoolAdmin &&
    await isDisputeInAdministratorSchool(currentDispute, session.user.id)
  if ((!isOwner && role !== 'SUPER_ADMIN' && !canManageSchoolDispute) || (isInternal && role !== 'SUPER_ADMIN')) {
    throw new Error('You are not allowed to reply to this dispute.')
  }

  const [newMessage] = await db.insert(disputeMessage).values({
    id: randomUUID(),
    disputeId,
    senderId: session.user.id,
    message,
    isInternal,
  }).returning()

  await db.update(dispute)
    .set({ updatedAt: new Date(), status: isOwner ? currentDispute.status : 'IN_PROGRESS' })
    .where(eq(dispute.id, disputeId))

  revalidatePath(`/dashboard/communication/disputes/${disputeId}`)
  return newMessage
}

export async function getMySupportTickets() {
  const session = await auth.getSession()
  if (!session?.user) throw new Error('Sign in to view your support tickets.')
  const tickets = await db.query.supportTicket.findMany({
    where: eq(supportTicket.userId, session.user.id),
    orderBy: [desc(supportTicket.updatedAt)],
  })
  return Promise.all(tickets.map(async (ticket) => ({
    ...ticket,
    replies: await db.query.supportTicketReply.findMany({
      where: eq(supportTicketReply.ticketId, ticket.id),
      orderBy: [desc(supportTicketReply.createdAt)],
    }),
  })))
}

export async function getSupportTicketReplies(ticketId: string) {
  const session = await auth.getSession()
  if (!session?.user) throw new Error('Sign in to view support replies.')
  const ticket = await db.query.supportTicket.findFirst({
    where: and(eq(supportTicket.id, ticketId), eq(supportTicket.userId, session.user.id)),
    columns: { id: true },
  })
  if (!ticket) throw new Error('Support ticket not found.')
  return db.query.supportTicketReply.findMany({
    where: eq(supportTicketReply.ticketId, ticketId),
    orderBy: [desc(supportTicketReply.createdAt)],
  })
}

export async function getMyDisputes() {
  const session = await auth.getSession()
  if (!session?.user) throw new Error('Sign in to view your disputes.')
  const disputes = await db.query.dispute.findMany({
    where: eq(dispute.raisedById, session.user.id),
    orderBy: [desc(dispute.updatedAt)],
  })
  return Promise.all(disputes.map(async (item) => ({
    ...item,
    messages: await db.query.disputeMessage.findMany({
      where: and(eq(disputeMessage.disputeId, item.id), eq(disputeMessage.isInternal, false)),
      orderBy: [desc(disputeMessage.createdAt)],
    }),
  })))
}

export async function createSupportTicket(data: {
  title: string
  category: string
  priority: string
  description: string
  contactName?: string
  contactEmail?: string
}) {
  const session = await auth.getSession()
  const title = requireText(data.title, 'Ticket title', 160)
  const description = requireText(data.description, 'Ticket description', 5000)
  const contactName = session?.user
    ? (await db.query.user.findFirst({ where: eq(user.id, session.user.id) }))?.name || 'Portal user'
    : requireText(data.contactName || '', 'Contact name', 120)
  const contactEmail = session?.user
    ? session.user.email
    : requireText(data.contactEmail || '', 'Contact email', 254).toLowerCase()

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    throw new Error('Enter a valid contact email address.')
  }

  const [created] = await db.insert(supportTicket).values({
    id: randomUUID(),
    ticketNumber: createTicketNumber('SUP'),
    title,
    category: requireText(data.category, 'Category', 80),
    priority: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'].includes(data.priority.toUpperCase())
      ? data.priority.toUpperCase()
      : 'MEDIUM',
    description,
    userId: session?.user.id || null,
    contactName,
    contactEmail,
    status: 'OPEN',
  }).returning()

  revalidatePath('/dashboard/super-admin/support')
  return created
}

export async function resolveDispute(disputeId: string, resolution: string) {
  const session = await auth.getSession()
  if (!session?.user || !['ADMIN', 'SCHOOL_ADMIN', 'SUPER_ADMIN'].includes(session.user.role.toUpperCase())) {
    throw new Error('Only school administrators can resolve disputes.')
  }
  const currentDispute = await db.query.dispute.findFirst({
    where: eq(dispute.id, disputeId),
  })
  if (!currentDispute) throw new Error('Dispute not found.')

  if (
    session.user.role.toUpperCase() !== 'SUPER_ADMIN' &&
    !await isDisputeInAdministratorSchool(currentDispute, session.user.id)
  ) {
    throw new Error('This dispute is outside your school.')
  }

  await db.update(dispute)
    .set({
      status: 'RESOLVED',
      resolution: requireText(resolution, 'Resolution', 5000),
      resolvedBy: session.user.id,
      resolvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(dispute.id, disputeId))

  revalidatePath('/dashboard/admin/communication/disputes')
  revalidatePath('/dashboard/parent/communication/disputes')
}

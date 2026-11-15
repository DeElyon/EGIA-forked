import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { db } from '@/lib/db'
import { notification, payment, parent } from '@/lib/db/schema'
import { sendPushNotification } from '@/lib/services/notifications'

export async function notifyPaymentConfirmed(paymentId: string) {
  const record = await db.query.payment.findFirst({
    where: eq(payment.id, paymentId),
    with: { student: true },
  })
  if (!record) return

  const linkedParent = record.parentId
    ? await db.query.parent.findFirst({ where: eq(parent.id, record.parentId) })
    : null
  const recipients = [...new Set([record.student.userId, linkedParent?.userId].filter(
    (userId): userId is string => Boolean(userId),
  ))]
  if (!recipients.length) return

  const studentName = `${record.student.firstName} ${record.student.lastName}`.trim()
  const amount = Number(record.amount)
  const reference = record.transactionReference || record.id
  const title = 'Payment confirmed'
  const body = `Payment of ₦${amount.toLocaleString('en-NG', { minimumFractionDigits: 2 })} for ${studentName} was recorded successfully.`
  const data = { paymentId: record.id, studentId: record.studentId, amount, reference }

  try {
    await db.insert(notification).values(recipients.map((userId) => ({
      id: randomUUID(),
      userId,
      schoolId: record.schoolId,
      title,
      message: body,
      type: 'payment_confirmation',
      metadata: data,
      actionUrl: '/dashboard/parent/payments/history',
      createdAt: new Date(),
    })))
  } catch (error) {
    console.error('Unable to persist payment confirmation notifications', {
      paymentId,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  await Promise.all(recipients.map(async (userId) => {
    try {
      await sendPushNotification({
        userId,
        eventKey: `payment-confirmed:${record.id}`,
        type: 'payment_confirmation',
        title,
        body,
        data,
        link: '/dashboard/parent/payments/history',
      })
    } catch (error) {
      console.error('Unable to deliver payment confirmation push notification', {
        paymentId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }))
}

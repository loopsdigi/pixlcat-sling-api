// OPTIMIZED Event-Driven Clock-In/Out Monitor
// Only checks when shifts start/end, not continuously

const SLING_ORG_ID = '593037';

// ============================================
// STATE MANAGEMENT
// ============================================
const monitoringState = {
  // Track shifts actively being monitored
  // Format: { shiftId: { employeeId, status: 'monitoring_clockin' | 'monitoring_clockout' | 'resolved', ... }}
  activeShifts: new Map(),
  
  // Track coverage requests awaiting reply
  // Format: { conversationId: { originalShiftId, sentAt, resolved: false }}
  pendingReplies: new Map(),
  
  // Track resolved issues to avoid re-checking
  // Format: Set of shiftIds that are fully resolved for today
  resolvedToday: new Set()
};

// ============================================
// HELPER: Get today's schedule with timing
// ============================================
async function getTodaySchedule() {
  const today = new Date().toISOString().split('T')[0];
  const response = await fetch(
    `https://pixlcat-sling-api.onrender.com/schedule/${today}`
  );
  return await response.json();
}

// ============================================
// HELPER: Parse name from message
// ============================================
function parseNameFromMessage(text) {
  const patterns = [
    /(\w+)\s+is covering/i,
    /(\w+)\s+covered/i,
    /(\w+)\s+will cover/i,
    /(\w+)\s+can cover/i,
    /got it covered,?\s+(\w+)/i,
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// ============================================
// MAIN: Smart Clock-In Check
// Runs every hour, but only checks shifts starting in the NEXT hour
// ============================================
app.get('/cron/smart-clockin-check', async (req, res) => {
  try {
    const now = new Date();
    const nowTime = now.getTime();
    const oneHourLater = nowTime + (60 * 60 * 1000);
    
    console.log(`🔍 Smart clock-in check at ${now.toLocaleTimeString()}`);
    
    // Get today's schedule
    const schedule = await getTodaySchedule();
    
    const checksPerformed = [];
    
    for (const shift of schedule) {
      const shiftStart = new Date(shift.startTime).getTime();
      const graceWindow = shiftStart + (10 * 60 * 1000); // +10 min grace
      
      // Only check shifts that:
      // 1. Start within the next hour
      // 2. We're currently past the grace window
      // 3. Haven't been resolved yet
      const shouldCheck = 
        shiftStart <= oneHourLater && 
        nowTime >= graceWindow &&
        !monitoringState.resolvedToday.has(shift.id);
      
      if (!shouldCheck) continue;
      
      // Check if already monitoring this shift
      const existing = monitoringState.activeShifts.get(shift.id);
      if (existing?.status === 'monitoring_clockin') {
        console.log(`⏭️  Already monitoring clock-in for shift ${shift.id}`);
        continue;
      }
      
      // Check if employee clocked in
      const clockedIn = await checkClockStatus(shift.userId, shift.startTime, 'in');
      
      if (clockedIn) {
        console.log(`✅ ${shift.userName} clocked in for ${shift.startTime}`);
        
        // Mark as resolved for clock-in
        monitoringState.activeShifts.set(shift.id, {
          employeeId: shift.userId,
          status: 'clockin_resolved',
          resolvedAt: new Date().toISOString()
        });
        
        checksPerformed.push({
          employee: shift.userName,
          shift: shift.startTime,
          status: 'clocked_in'
        });
        
      } else {
        console.log(`❌ ${shift.userName} missing clock-in for ${shift.startTime}`);
        
        // Send reminder DM
        const dmResponse = await fetch('https://pixlcat-sling-api.onrender.com/messages/dm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: shift.userId,
            text: `Hey ${shift.firstName}! You're scheduled at ${new Date(shift.startTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} but haven't clocked in yet. Everything ok?`
          })
        });
        
        const dmResult = await dmResponse.json();
        
        // Track for reply monitoring
        monitoringState.activeShifts.set(shift.id, {
          employeeId: shift.userId,
          status: 'monitoring_clockin',
          reminderSent: new Date().toISOString(),
          conversationId: dmResult.conversationId
        });
        
        monitoringState.pendingReplies.set(dmResult.conversationId, {
          shiftId: shift.id,
          sentAt: new Date().toISOString(),
          resolved: false
        });
        
        checksPerformed.push({
          employee: shift.userName,
          shift: shift.startTime,
          status: 'reminder_sent',
          conversationId: dmResult.conversationId
        });
      }
    }
    
    res.json({
      timestamp: now.toISOString(),
      shiftsChecked: checksPerformed.length,
      checks: checksPerformed,
      activeMonitoring: monitoringState.activeShifts.size,
      pendingReplies: monitoringState.pendingReplies.size
    });
    
  } catch (error) {
    console.error('Error in smart clock-in check:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// MAIN: Smart Reply Parser
// Runs every hour, only checks unresolved conversations
// ============================================
app.get('/cron/smart-reply-check', async (req, res) => {
  try {
    console.log(`💬 Smart reply check - ${monitoringState.pendingReplies.size} pending`);
    
    const processedReplies = [];
    const conversationsToRemove = [];
    
    for (const [conversationId, pending] of monitoringState.pendingReplies.entries()) {
      
      if (pending.resolved) {
        console.log(`✅ Conversation ${conversationId} already resolved`);
        conversationsToRemove.push(conversationId);
        continue;
      }
      
      // Get messages from this conversation
      const messagesResponse = await fetch(
        `https://pixlcat-sling-api.onrender.com/messages/conversations/${conversationId}/messages`
      );
      const messages = await messagesResponse.json();
      
      // Find new messages after we sent the reminder
      const sentTime = new Date(pending.sentAt);
      const newMessages = messages.filter(m => 
        new Date(m.createdAt) > sentTime &&
        m.userId !== 'BOT_USER_ID' // Not from bot
      );
      
      if (newMessages.length === 0) continue;
      
      // Process the latest reply
      const latestReply = newMessages[newMessages.length - 1];
      console.log(`📩 Reply in conversation ${conversationId}: "${latestReply.text}"`);
      
      // Parse for coverage info
      const coveringName = parseNameFromMessage(latestReply.text);
      
      if (coveringName) {
        console.log(`✅ Coverage detected: ${coveringName}`);
        
        // Find covering employee
        const coveringEmployee = await findUserByName(coveringName);
        
        if (!coveringEmployee) {
          await sendDM(pending.originalEmployeeId, 
            `I couldn't find "${coveringName}" in the system. Can you double-check the name?`
          );
          continue;
        }
        
        // Get shift details
        const shift = monitoringState.activeShifts.get(pending.shiftId);
        const shiftDetails = await getShiftById(pending.shiftId);
        
        // Check if covering employee clocked in
        const clockedIn = await checkClockStatus(
          coveringEmployee.id, 
          shiftDetails.startTime, 
          'in'
        );
        
        if (clockedIn) {
          // Already clocked in!
          await sendDM(shift.employeeId,
            `Perfect! ${coveringEmployee.firstName} already clocked in. You're all set 👍`
          );
          
          // Update monitoring to track coverage clock-out
          monitoringState.activeShifts.set(pending.shiftId, {
            ...shift,
            status: 'monitoring_coverage_clockout',
            coveredBy: coveringEmployee.id,
            coveringName: coveringEmployee.firstName,
            originalEnd: shiftDetails.endTime
          });
          
        } else {
          // Not clocked in - remind covering person
          await sendDM(coveringEmployee.id,
            `Hey ${coveringEmployee.firstName}! ${shift.employeeName} said you're covering their shift (${new Date(shiftDetails.startTime).toLocaleTimeString()} - ${new Date(shiftDetails.endTime).toLocaleTimeString()}). Can you clock in now?`
          );
          
          await sendDM(shift.employeeId,
            `Got it! I messaged ${coveringEmployee.firstName} to clock in.`
          );
          
          // Keep monitoring for coverage employee to clock in
          monitoringState.activeShifts.set(pending.shiftId, {
            ...shift,
            status: 'pending_coverage_clockin',
            coveredBy: coveringEmployee.id,
            coveringName: coveringEmployee.firstName
          });
        }
        
        // Mark conversation as resolved
        pending.resolved = true;
        
        processedReplies.push({
          conversationId,
          coveringEmployee: coveringEmployee.firstName,
          status: clockedIn ? 'coverage_active' : 'coverage_pending'
        });
      }
    }
    
    // Clean up resolved conversations
    for (const convId of conversationsToRemove) {
      monitoringState.pendingReplies.delete(convId);
    }
    
    res.json({
      repliesProcessed: processedReplies.length,
      stillPending: monitoringState.pendingReplies.size,
      details: processedReplies
    });
    
  } catch (error) {
    console.error('Error in smart reply check:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// MAIN: Smart Clock-Out Check
// Runs every 15 min, only checks shifts ending now ±15 min
// ============================================
app.get('/cron/smart-clockout-check', async (req, res) => {
  try {
    const now = new Date();
    const nowTime = now.getTime();
    
    console.log(`⏰ Smart clock-out check at ${now.toLocaleTimeString()}`);
    
    // Get today's schedule
    const schedule = await getTodaySchedule();
    
    const checksPerformed = [];
    
    for (const shift of schedule) {
      const shiftEnd = new Date(shift.endTime).getTime();
      const checkWindow = 15 * 60 * 1000; // 15 minutes
      
      // Only check shifts ending within ±15 min of now
      const withinWindow = Math.abs(nowTime - shiftEnd) <= checkWindow;
      
      if (!withinWindow) continue;
      
      // Check if already resolved
      if (monitoringState.resolvedToday.has(shift.id)) continue;
      
      // Determine who should clock out
      const shiftStatus = monitoringState.activeShifts.get(shift.id);
      let employeeToCheck = shift.userId;
      let employeeName = shift.userName;
      
      // If there's coverage, check the covering employee instead
      if (shiftStatus?.coveredBy) {
        employeeToCheck = shiftStatus.coveredBy;
        employeeName = shiftStatus.coveringName;
      }
      
      // Check if they clocked out
      const clockedOut = await checkClockStatus(employeeToCheck, shift.endTime, 'out');
      
      if (clockedOut) {
        console.log(`✅ ${employeeName} clocked out for shift ending ${shift.endTime}`);
        
        // Mark as fully resolved
        monitoringState.resolvedToday.add(shift.id);
        monitoringState.activeShifts.delete(shift.id);
        
        checksPerformed.push({
          employee: employeeName,
          shift: shift.endTime,
          status: 'clocked_out'
        });
        
      } else {
        console.log(`❌ ${employeeName} hasn't clocked out (shift ended ${shift.endTime})`);
        
        // Only send reminder if we haven't already
        if (!shiftStatus?.clockoutReminderSent) {
          await sendDM(employeeToCheck,
            `Hey ${employeeName.split(' ')[0]}! Your shift ended at ${new Date(shift.endTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}. Don't forget to clock out!`
          );
          
          // Mark that we sent reminder
          monitoringState.activeShifts.set(shift.id, {
            ...shiftStatus,
            clockoutReminderSent: new Date().toISOString()
          });
          
          checksPerformed.push({
            employee: employeeName,
            shift: shift.endTime,
            status: 'reminder_sent'
          });
        }
      }
    }
    
    res.json({
      timestamp: now.toISOString(),
      shiftsChecked: checksPerformed.length,
      checks: checksPerformed,
      resolvedToday: monitoringState.resolvedToday.size
    });
    
  } catch (error) {
    console.error('Error in smart clock-out check:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// UTILITY: Reset daily state (run at midnight)
// ============================================
app.get('/cron/reset-daily-state', async (req, res) => {
  console.log('🔄 Resetting daily monitoring state...');
  
  monitoringState.activeShifts.clear();
  monitoringState.pendingReplies.clear();
  monitoringState.resolvedToday.clear();
  
  res.json({ 
    status: 'reset',
    timestamp: new Date().toISOString()
  });
});

// ============================================
// Helper functions
// ============================================
async function checkClockStatus(userId, time, type = 'in') {
  // Your Toast API integration here
  // Returns true if clocked in/out within 30 min tolerance
}

async function findUserByName(firstName) {
  const response = await fetch('https://pixlcat-sling-api.onrender.com/users');
  const data = await response.json();
  return data.users.find(u => 
    u.firstName?.toLowerCase() === firstName.toLowerCase()
  );
}

async function sendDM(userId, text) {
  return fetch('https://pixlcat-sling-api.onrender.com/messages/dm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, text })
  });
}

async function getShiftById(shiftId) {
  const schedule = await getTodaySchedule();
  return schedule.find(s => s.id === shiftId);
}

// ============================================
// Debug endpoint
// ============================================
app.get('/monitoring/status', (req, res) => {
  res.json({
    activeShifts: Array.from(monitoringState.activeShifts.entries()),
    pendingReplies: Array.from(monitoringState.pendingReplies.entries()),
    resolvedToday: Array.from(monitoringState.resolvedToday)
  });
});

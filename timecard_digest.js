// ============================================
// TIMECARD ADJUSTMENTS EMAIL DIGEST
// Reads Sling "timecard adjustments" group conversation
// Sends weekly digest every Monday at 8am PT
// ============================================

const SLING_TOKEN = process.env.SLING_TOKEN;
const SLING_ORG_ID = process.env.SLING_ORG_ID || '593037'; // Default org ID from index.js

// Email configuration
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const EMAIL_FROM = 'noreply@pixlcatcoffee.com';
const EMAIL_TO = ['jeff@pixlcatcoffee.com', 'david@pixlcatcoffee.com'];

// ============================================
// STEP 1: Find the "timecard adjustments" conversation
// ============================================
async function findTimecardConversation() {
  const conversationsUrl = `https://api.getsling.com/v1/${SLING_ORG_ID}/conversations`;
  
  const response = await fetch(conversationsUrl, {
    headers: {
      'Authorization': SLING_TOKEN,
      'Content-Type': 'application/json'
    }
  });
  
  if (!response.ok) {
    throw new Error(`Failed to fetch conversations: ${response.status}`);
  }
  
  const conversations = await response.json();
  
  // Find conversation by name (case-insensitive)
  const timecardConv = conversations.find(c => 
    c.name?.toLowerCase().includes('timecard') && 
    c.name?.toLowerCase().includes('adjustment')
  );
  
  if (!timecardConv) {
    throw new Error('Could not find "timecard adjustments" conversation');
  }
  
  return timecardConv;
}

// ============================================
// STEP 2: Get messages from last week (Monday-Sunday)
// ============================================
async function getLastWeekMessages(conversationId) {
  // Calculate last week's date range (Monday-Sunday)
  const now = new Date();
  const today = now.getDay(); // 0 = Sunday, 1 = Monday
  
  // Get last Monday
  const daysToLastMonday = today === 0 ? 7 : today + 6; // If Sunday, go back 7 days
  const lastMonday = new Date(now);
  lastMonday.setDate(now.getDate() - daysToLastMonday);
  lastMonday.setHours(0, 0, 0, 0);
  
  // Get last Sunday
  const lastSunday = new Date(lastMonday);
  lastSunday.setDate(lastMonday.getDate() + 6);
  lastSunday.setHours(23, 59, 59, 999);
  
  console.log(`Fetching messages from ${lastMonday.toISOString()} to ${lastSunday.toISOString()}`);
  
  // Fetch messages from conversation
  const messagesUrl = `https://api.getsling.com/v1/${SLING_ORG_ID}/conversations/${conversationId}/messages`;
  
  const response = await fetch(messagesUrl, {
    headers: {
      'Authorization': SLING_TOKEN,
      'Content-Type': 'application/json'
    }
  });
  
  if (!response.ok) {
    throw new Error(`Failed to fetch messages: ${response.status}`);
  }
  
  const allMessages = await response.json();
  
  // Filter messages from last week
  const lastWeekMessages = allMessages.filter(msg => {
    const msgDate = new Date(msg.createdAt || msg.created);
    return msgDate >= lastMonday && msgDate <= lastSunday;
  });
  
  return {
    messages: lastWeekMessages,
    dateRange: {
      start: lastMonday,
      end: lastSunday
    }
  };
}

// ============================================
// STEP 3: Format messages into email HTML
// ============================================
function formatEmailHTML(messages, dateRange) {
  const startDate = dateRange.start.toLocaleDateString('en-US', { 
    month: 'short', 
    day: 'numeric',
    year: 'numeric'
  });
  const endDate = dateRange.end.toLocaleDateString('en-US', { 
    month: 'short', 
    day: 'numeric',
    year: 'numeric'
  });
  
  let html = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    .header { background: #f5f5f5; padding: 20px; margin-bottom: 20px; }
    .message { border-left: 3px solid #4CAF50; padding: 15px; margin: 10px 0; background: #fafafa; }
    .message-header { font-weight: bold; color: #333; margin-bottom: 5px; }
    .message-text { color: #666; line-height: 1.5; }
    .timestamp { color: #999; font-size: 12px; }
    .summary { background: #fff3cd; padding: 15px; margin: 20px 0; border-left: 3px solid #ffc107; }
  </style>
</head>
<body>
  <div class="header">
    <h2>📋 Timecard Adjustments - Weekly Digest</h2>
    <p><strong>Period:</strong> ${startDate} - ${endDate}</p>
    <p><strong>Total Messages:</strong> ${messages.length}</p>
  </div>
`;

  if (messages.length === 0) {
    html += `
  <div class="summary">
    <p>✅ No timecard adjustment requests this week!</p>
  </div>
`;
  } else {
    // Group messages by employee
    const byEmployee = {};
    
    messages.forEach(msg => {
      const author = msg.user?.fullName || msg.user?.firstName || 'Unknown';
      if (!byEmployee[author]) {
        byEmployee[author] = [];
      }
      byEmployee[author].push(msg);
    });
    
    // Summary stats
    const employeeCount = Object.keys(byEmployee).length;
    html += `
  <div class="summary">
    <p><strong>${employeeCount}</strong> employee(s) submitted timecard adjustments</p>
  </div>
  
  <h3>Messages:</h3>
`;
    
    // Display messages chronologically
    messages
      .sort((a, b) => new Date(a.createdAt || a.created) - new Date(b.createdAt || b.created))
      .forEach(msg => {
        const author = msg.user?.fullName || msg.user?.firstName || 'Unknown';
        const timestamp = new Date(msg.createdAt || msg.created).toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        });
        const text = msg.text || msg.body || '';
        
        html += `
  <div class="message">
    <div class="message-header">${author}</div>
    <div class="timestamp">${timestamp}</div>
    <div class="message-text">${text.replace(/\n/g, '<br>')}</div>
  </div>
`;
      });
  }
  
  html += `
</body>
</html>
`;
  
  return html;
}

// ============================================
// STEP 4: Send email via SendGrid
// ============================================
async function sendEmail(html, dateRange) {
  const startDate = dateRange.start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const endDate = dateRange.end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  
  const subject = `Timecard Adjustments Digest - ${startDate} to ${endDate}`;
  
  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SENDGRID_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      personalizations: [
        {
          to: EMAIL_TO.map(email => ({ email })),
          subject
        }
      ],
      from: { email: EMAIL_FROM },
      content: [
        {
          type: 'text/html',
          value: html
        }
      ]
    })
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`SendGrid error: ${response.status} - ${error}`);
  }
  
  console.log('✅ Email sent successfully');
}

// ============================================
// MAIN: Generate and send digest
// ============================================
async function generateDigest() {
  try {
    console.log('🔍 Finding timecard adjustments conversation...');
    const conversation = await findTimecardConversation();
    console.log(`✅ Found conversation: "${conversation.name}" (ID: ${conversation.id})`);
    
    console.log('📥 Fetching messages from last week...');
    const { messages, dateRange } = await getLastWeekMessages(conversation.id);
    console.log(`✅ Found ${messages.length} messages`);
    
    console.log('📧 Formatting email...');
    const html = formatEmailHTML(messages, dateRange);
    
    console.log('📬 Sending email...');
    await sendEmail(html, dateRange);
    
    console.log('✅ Digest sent successfully!');
    
    return {
      success: true,
      messageCount: messages.length,
      dateRange: {
        start: dateRange.start.toISOString(),
        end: dateRange.end.toISOString()
      }
    };
    
  } catch (error) {
    console.error('❌ Error generating digest:', error);
    throw error;
  }
}

// Export for use in endpoints
module.exports = { generateDigest, findTimecardConversation, getLastWeekMessages };

// Run if called directly
if (require.main === module) {
  generateDigest()
    .then(result => {
      console.log('Result:', result);
      process.exit(0);
    })
    .catch(error => {
      console.error('Failed:', error);
      process.exit(1);
    });
}

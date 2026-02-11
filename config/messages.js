const MESSAGES = [
  "Hey, saw your post—cool stuff!",
  "Quick question about your content...",
  "Loving your vibe, let's chat.",
  "Hi there, thought you'd like this.",
  "What's up? Your page is awesome."
];

function getRandomMessage() {
  return MESSAGES[Math.floor(Math.random() * MESSAGES.length)];
}

module.exports = { MESSAGES, getRandomMessage };

'use strict';

const clipboardTextSearchStrategy = require('./clipboardTextSearchStrategy');
const indexedTerminalSelectionSearchStrategy = require('./indexedTerminalSelectionSearchStrategy');
const terminalSelectionTextSearchStrategy = require('./terminalSelectionTextSearchStrategy');

const strategies = [
  terminalSelectionTextSearchStrategy,
  indexedTerminalSelectionSearchStrategy,
  clipboardTextSearchStrategy
];

const strategyMap = new Map(
  strategies.map((strategy) => [strategy.strategyDefinition.id, strategy])
);

function getSelectionTrackingStrategy(strategyId) {
  return (
    strategyMap.get(strategyId) ||
    strategyMap.get(terminalSelectionTextSearchStrategy.strategyDefinition.id)
  );
}

function getSelectionTrackingStrategyDefinitions() {
  return strategies.map((strategy) => strategy.strategyDefinition);
}

module.exports = {
  getSelectionTrackingStrategy,
  getSelectionTrackingStrategyDefinitions
};

<template>
  <div class="take-screenshot">
    <ui-textarea
      :model-value="data.description"
      :placeholder="t('common.description')"
      class="w-full"
      @change="updateData({ description: $event })"
    />
    <div class="mt-2">
      <p class="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
        {{ t('workflow.blocks.take-screenshot-and-log.types.title') }}
      </p>
      <div class="space-y-3">
        <ui-checkbox
          v-for="type in screenshotTypes"
          :key="type"
          :model-value="isTypeSelected(type)"
          class="block w-full"
          @change="toggleType(type, $event)"
        >
          <span class="ml-2">{{
            t(`workflow.blocks.take-screenshot-and-log.types.${type}`)
          }}</span>
        </ui-checkbox>
      </div>
    </div>

    <div class="mt-4">
      <p class="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
        {{ t('workflow.blocks.take-screenshot-and-log.htmlCapture.title') }}
      </p>
      <ui-checkbox
        :model-value="data.captureHTML"
        class="block w-full"
        @change="updateData({ captureHTML: $event })"
      >
        <span class="ml-2">{{
          t('workflow.blocks.take-screenshot-and-log.htmlCapture.enabled')
        }}</span>
      </ui-checkbox>
      <p
        v-if="data.captureHTML"
        class="mt-1 text-xs text-gray-500 dark:text-gray-400"
      >
        {{
          t('workflow.blocks.take-screenshot-and-log.htmlCapture.description')
        }}
        <br />
        <span v-if="!data.saveToComputer" class="text-orange-500">
          {{
            t('workflow.blocks.take-screenshot-and-log.htmlCapture.noDownload')
          }}
        </span>
      </p>
    </div>
    <ui-input
      v-if="data.captureHTML"
      :model-value="data.selector"
      :label="t(`workflow.blocks.base.findElement.options.cssSelector`)"
      class="mt-2 w-full"
      placeholder=".element"
      @change="updateData({ selector: $event })"
    />
    <template v-if="data.ext === 'jpeg'">
      <p class="ml-2 mt-4 text-sm text-gray-600 dark:text-gray-200">
        {{ t('workflow.blocks.take-screenshot-and-log.imageQuality') }}
      </p>
      <div class="bg-box-transparent flex items-center rounded-lg px-4 py-2">
        <input
          :value="data.quality"
          :title="t('workflow.blocks.take-screenshot-and-log.imageQuality')"
          class="flex-1 focus:outline-none"
          type="range"
          min="0"
          max="100"
          @change="updateQuality"
        />
        <span class="w-12 text-right">{{ data.quality }}%</span>
      </div>
    </template>
    <ui-checkbox
      :model-value="data.saveToComputer"
      class="mt-4"
      @change="updateData({ saveToComputer: $event })"
    >
      {{ t('workflow.blocks.take-screenshot-and-log.saveToComputer') }}
    </ui-checkbox>
    <div v-if="data.saveToComputer" class="mt-1 flex items-center">
      <edit-autocomplete class="mr-2 flex-1">
        <ui-input
          :model-value="data.fileName"
          :placeholder="t('common.fileName')"
          autocomplete="off"
          class="mr-2 flex-1"
          title="File name"
          @change="updateData({ fileName: $event })"
        />
      </edit-autocomplete>
      <ui-select
        :model-value="data.ext || 'png'"
        placeholder="Type"
        @change="updateData({ ext: $event })"
      >
        <option value="png">PNG</option>
        <option value="jpeg">JPEG</option>
      </ui-select>
    </div>
    <ui-checkbox
      :model-value="data.saveToColumn"
      class="mt-4"
      @change="updateData({ saveToColumn: $event })"
    >
      {{ t('workflow.blocks.take-screenshot-and-log.saveToColumn') }}
    </ui-checkbox>
    <ui-select
      v-if="data.saveToColumn"
      :model-value="data.dataColumn"
      placeholder="Select column"
      class="mt-1 w-full"
      @change="updateData({ dataColumn: $event })"
    >
      <option
        v-for="column in workflow.columns.value"
        :key="column.id || column.name"
        :value="column.id || column.name"
      >
        {{ column.name }}
      </option>
    </ui-select>
    <ui-checkbox
      :model-value="data.assignVariable"
      block
      class="mt-4"
      @change="updateData({ assignVariable: $event })"
    >
      {{ t('workflow.variables.assign') }}
    </ui-checkbox>

    <!-- Multiple variable inputs based on selected types -->
    <div v-if="data.assignVariable" class="mt-2 space-y-2">
      <div
        v-for="(type, index) in getSelectedTypes()"
        :key="type"
        class="flex items-center space-x-2"
      >
        <ui-input
          :model-value="getVariableName(type, index)"
          :placeholder="`${t('workflow.variables.name')} for ${t(
            `workflow.blocks.take-screenshot-and-log.types.${type}`
          )}`"
          :title="`${t('workflow.variables.name')} for ${t(
            `workflow.blocks.take-screenshot-and-log.types.${type}`
          )}`"
          class="flex-1"
          @change="updateVariableName(type, index, $event)"
        />
        <span class="text-sm text-gray-500 dark:text-gray-400">
          {{ t(`workflow.blocks.take-screenshot-and-log.types.${type}`) }}
        </span>
      </div>

      <!-- HTML capture variable -->
      <div v-if="data.captureHTML" class="flex items-center space-x-2">
        <ui-input
          :model-value="data.htmlVariableName || 'htmlContent'"
          :placeholder="`${t('workflow.variables.name')} for HTML`"
          :title="`${t('workflow.variables.name')} for HTML`"
          class="flex-1"
          @change="updateData({ htmlVariableName: $event })"
        />
        <span class="text-sm text-gray-500 dark:text-gray-400">
          {{
            data.selector && data.selector.trim()
              ? 'Element HTML'
              : 'Full Page HTML'
          }}
        </span>
      </div>
    </div>
  </div>
</template>
<script setup>
/* eslint-disable no-unused-expressions */
import { inject, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { objectHasKey } from '@/utils/helper';
import EditAutocomplete from './EditAutocomplete.vue';

const props = defineProps({
  data: {
    type: Object,
    default: () => ({}),
  },
});
const emit = defineEmits(['update:data']);

const { t } = useI18n();
const workflow = inject('workflow');

const screenshotTypes = ['page', 'fullpage'];

function updateData(value) {
  emit('update:data', { ...props.data, ...value });
}

function updateQuality({ target }) {
  let quality = +target.value;

  if (quality <= 0) quality = 0;
  if (quality >= 100) quality = 100;

  updateData({ quality });
}

// Multi-select functions
function isTypeSelected(type) {
  if (Array.isArray(props.data.types)) {
    return props.data.types.includes(type);
  }
  if (props.data.type) {
    return props.data.type === type;
  }
  return false;
}

function toggleType(type, isSelected) {
  let currentTypes = [];
  if (Array.isArray(props.data.types)) {
    currentTypes = [...props.data.types];
  } else if (props.data.type) {
    currentTypes = [props.data.type];
  }

  if (isSelected) {
    if (!currentTypes.includes(type)) {
      currentTypes.push(type);
    }
  } else {
    const index = currentTypes.indexOf(type);
    if (index > -1) {
      currentTypes.splice(index, 1);
    }
  }

  updateData({ types: currentTypes });
}

// Get selected types for variable assignment
function getSelectedTypes() {
  if (Array.isArray(props.data.types)) {
    return props.data.types;
  }
  if (props.data.type) {
    return [props.data.type];
  }
  return [];
}

// Get variable name for a specific type
function getVariableName(type, index) {
  const variableNames = props.data.variableNames || {};
  return variableNames[type] || `${type}_${index + 1}`;
}

// Update variable name for a specific type
function updateVariableName(type, index, value) {
  const variableNames = { ...(props.data.variableNames || {}) };
  variableNames[type] = value;
  updateData({ variableNames });
}

onMounted(() => {
  if (!objectHasKey(props.data, 'saveToComputer')) {
    updateData({ saveToComputer: true, saveToColumn: false });
  }

  // Initialize captureHTML if not set
  if (!objectHasKey(props.data, 'captureHTML')) {
    updateData({ captureHTML: false });
  }

  // Handle migration from old single type to new multi-type format
  if (!objectHasKey(props.data, 'types')) {
    let initialTypes = [];

    if (props.data.type) {
      // Migrate from old single type format
      initialTypes = [props.data.type];
    } else if (props.data.fullPage) {
      // Handle legacy fullPage flag
      initialTypes = ['fullpage'];
    }
    // If no legacy data, let shared.js default handle it

    if (initialTypes.length > 0) {
      updateData({ types: initialTypes });
    }
  }
});
</script>

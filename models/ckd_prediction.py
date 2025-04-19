# Libraries
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import seaborn as sns
from sklearn.model_selection import train_test_split, RandomizedSearchCV
from sklearn.preprocessing import StandardScaler, OneHotEncoder
from sklearn.compose import ColumnTransformer
from sklearn.pipeline import Pipeline
from sklearn.impute import SimpleImputer
from sklearn.metrics import (accuracy_score, roc_auc_score, classification_report,confusion_matrix, roc_curve, precision_recall_curve)
from xgboost import XGBClassifier
from imblearn.pipeline import Pipeline as ImbPipeline
from imblearn.over_sampling import SMOTE
import shap
import joblib
import warnings
warnings.filterwarnings('ignore')

# ======================
# 1. Load Dataset
# ======================
df = pd.read_csv('C:/Users/krith/Desktop/Model/kidney_disease (1).csv')

# Convert target variable
df['classification'] = df['classification'].apply(lambda x: 1 if x == 'ckd' else 0)

# ======================
# 2. Feature Engineering
# ======================
def create_features(df):
    df['eGFR'] = 175 * (df['sc']**-1.154) * (df['age']**-0.203)
    df['bun_creatinine_ratio'] = df['bu'] / df['sc']
    df['hemo_albumin_ratio'] = df['hemo'] / (df['al'] + 0.001)
    df['high_bp'] = (df['bp'] > 140).astype(int)
    df['anemia'] = (((df['hemo'] < 13) & (df['gender'] == 'male')) |
                    ((df['hemo'] < 12) & (df['gender'] == 'female'))).astype(int)
    return df

df = create_features(df)

# ======================
# 3. Preprocessing Setup
# ======================
num_features = ['age', 'bp', 'sg', 'al', 'su', 'bgr', 'bu', 'sc', 'sod', 
                'pot', 'hemo', 'pcv', 'wc', 'rc', 'eGFR', 'bun_creatinine_ratio',
                'hemo_albumin_ratio']
cat_features = ['rbc', 'pc', 'pcc', 'ba', 'htn', 'dm', 'cad', 'appet', 'pe', 'ane',
                'high_bp', 'anemia']

num_pipeline = Pipeline([
    ('imputer', SimpleImputer(strategy='median')),
    ('scaler', StandardScaler())
])

cat_pipeline = Pipeline([
    ('imputer', SimpleImputer(strategy='most_frequent')),
    ('onehot', OneHotEncoder(handle_unknown='ignore', sparse=False))
])

preprocessor = ColumnTransformer([
    ('num', num_pipeline, num_features),
    ('cat', cat_pipeline, cat_features)
])

# ======================
# 4. Train-Test Split
# ======================
X = df.drop(['id', 'classification'], axis=1)
y = df['classification']
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, 
                                                    random_state=42, stratify=y)

# ======================
# 5. XGBoost + SMOTE Pipeline
# ======================
pipeline = ImbPipeline([
    ('preprocessor', preprocessor),
    ('smote', SMOTE(random_state=42)),
    ('classifier', XGBClassifier(random_state=42, scale_pos_weight=len(y_train[y_train==0]) / len(y_train[y_train==1])))
])

# Fit model
pipeline.fit(X_train, y_train)

# Predict
y_pred = pipeline.predict(X_test)
y_prob = pipeline.predict_proba(X_test)[:, 1]

# ======================
# 6. Evaluation
# ======================
print("Accuracy:", accuracy_score(y_test, y_pred))
print("ROC AUC:", roc_auc_score(y_test, y_prob))
print("\nClassification Report:")
print(classification_report(y_test, y_pred))

# Confusion Matrix
cm = confusion_matrix(y_test, y_pred)
sns.heatmap(cm, annot=True, fmt='d', cmap='Blues')
plt.title("Confusion Matrix")
plt.xlabel("Predicted")
plt.ylabel("Actual")
plt.show()

# ======================
# 7. SHAP Explainability
# ======================
preprocessor.fit(X_train)
X_train_proc = preprocessor.transform(X_train)
feature_names = num_features + list(preprocessor.named_transformers_['cat']
                                    .named_steps['onehot'].get_feature_names_out(cat_features))

xgb_model = pipeline.named_steps['classifier']
explainer = shap.Explainer(xgb_model)
shap_values = explainer(X_train_proc)

shap.summary_plot(shap_values, features=X_train_proc, feature_names=feature_names, plot_type="bar")

# ======================
# 8. Save Model
# ======================
joblib.dump(pipeline, 'ckd_model.pkl')
print("✅ Model saved as 'ckd_model.pkl'")
